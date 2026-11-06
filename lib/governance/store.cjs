/**
 * Mongo persistence for self-hosted governance. Works with both a direct MONGODB_URI and
 * the mongo-proxy client (only find / findOne / insertOne / updateOne; no transactions).
 *
 *   governance_proposals   one doc per proposal (id = keccak of its immutable fields)
 *   governance_vp_frozen   subgraph-sourced VP tables frozen at proposal creation
 *   governance_votes       one doc per (proposal, voter) — the latest signed vote wins
 *   governance_proposers   wallets added on the admin DAO "Proposers" tab (active: false = removed)
 *   governance_archive_proposals / governance_archive_votes
 *                          read-only copy of the legacy Snapshot space (snapshotArchive.cjs)
 */
const { connect } = require('../mongodb.cjs');

// Same database as the rest of the app (mirrors MONGO_DB_NAME in lib/mongodb.cjs).
const DB_NAME = (process.env.MONGO_DB_NAME || 'Gotchinopoly').trim();
/**
 * Collection-name prefix. Tests MUST isolate by prefix, not database: the mongo-proxy
 * silently maps unknown database names to the main app database.
 */
const PREFIX = (process.env.GOVERNANCE_COLLECTION_PREFIX || 'governance_').trim();
const col = async (name) => (await connect()).db(DB_NAME).collection(name.replace(/^governance_/, PREFIX));

async function insertProposal(doc) {
  await (await col('governance_proposals')).insertOne(doc);
  return doc;
}

async function getProposal(id) {
  return (await col('governance_proposals')).findOne({ id: String(id).toLowerCase() }, { projection: { _id: 0 } });
}

async function listProposals({ limit = 50, skip = 0, electionId, category, author } = {}) {
  const filter = {};
  if (electionId) filter.electionId = String(electionId);
  if (category) filter.category = String(category);
  if (author) filter.author = String(author).toLowerCase();
  return (await col('governance_proposals'))
    .find(filter, { projection: { _id: 0 } })
    .sort({ created: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

async function updateProposal(id, set) {
  await (await col('governance_proposals')).updateOne({ id: String(id).toLowerCase() }, { $set: set });
}

async function saveFrozen(proposalId, strategy, block, scores, groveUri) {
  await (await col('governance_vp_frozen')).updateOne(
    { proposalId, strategy },
    { $set: { proposalId, strategy, block, scores, groveUri } },
    { upsert: true },
  );
}

/** @returns {Promise<Record<string, Record<string, number>>>} strategy → (address → vp) */
async function getFrozen(proposalId) {
  const rows = await (await col('governance_vp_frozen')).find({ proposalId }, { projection: { _id: 0 } }).toArray();
  return Object.fromEntries(rows.map((r) => [r.strategy, r.scores]));
}

async function getVote(proposalId, voter) {
  return (await col('governance_votes')).findOne({ proposalId, voter: voter.toLowerCase() }, { projection: { _id: 0 } });
}

/**
 * Upsert a voter's vote, but only if it is newer than what's stored — a replayed older
 * signature can never overwrite a later vote.
 * @returns {Promise<boolean>} false when a newer-or-equal vote already exists
 */
async function upsertVoteIfNewer(doc) {
  const votes = await col('governance_votes');
  const existing = await votes.findOne({ proposalId: doc.proposalId, voter: doc.voter });
  if (existing && existing.timestamp >= doc.timestamp) return false;
  if (existing) {
    const r = await votes.updateOne(
      { proposalId: doc.proposalId, voter: doc.voter, timestamp: existing.timestamp },
      { $set: doc },
    );
    return (r?.matchedCount ?? r?.modifiedCount ?? 1) > 0;
  }
  await votes.insertOne(doc);
  return true;
}

async function listVotes(proposalId, { limit = 5000 } = {}) {
  return (await col('governance_votes'))
    .find({ proposalId }, { projection: { _id: 0 } })
    .sort({ vp: -1 })
    .limit(limit)
    .toArray();
}

async function hasVotes(proposalId) {
  return Boolean(await (await col('governance_votes')).findOne({ proposalId }, { projection: { _id: 0, voter: 1 } }));
}

async function listVotedProposalIds(voter) {
  const rows = await (await col('governance_votes'))
    .find({ voter: voter.toLowerCase() }, { projection: { _id: 0, proposalId: 1 } })
    .toArray();
  return rows.map((r) => r.proposalId);
}

async function setVoteGroveUri(proposalId, voter, timestamp, groveUri) {
  await (await col('governance_votes')).updateOne({ proposalId, voter, timestamp }, { $set: { groveUri } });
}

/** Record the decrypted choice (or why it was voided) for a shielded vote. */
async function setVoteReveal(proposalId, voter, timestamp, set) {
  await (await col('governance_votes')).updateOne({ proposalId, voter, timestamp }, { $set: set });
}

async function getProposer(address) {
  return (await col('governance_proposers')).findOne(
    { address: String(address).toLowerCase(), active: true },
    { projection: { _id: 0 } },
  );
}

async function listProposers() {
  return (await col('governance_proposers'))
    .find({ active: true }, { projection: { _id: 0 } })
    .sort({ addedAt: -1 })
    .toArray();
}

/** Any whitelist record for a wallet, including removed ones (auto-sync must not re-add those). */
async function getProposerRecord(address) {
  return (await col('governance_proposers')).findOne({ address: String(address).toLowerCase() }, { projection: { _id: 0 } });
}

/** Add (or re-activate) a proposer. Removal flips `active` — the mongo-proxy has no delete. */
async function setProposer(address, set) {
  await (await col('governance_proposers')).updateOne(
    { address: String(address).toLowerCase() },
    { $set: { address: String(address).toLowerCase(), ...set } },
    { upsert: true },
  );
}

/* ------------------------------------------------------------ Voter names (lib/governance/names.cjs) */

async function getNames(addresses) {
  return (await col('governance_names')).find({ address: { $in: addresses } }, { projection: { _id: 0 } }).toArray();
}

async function setNames(rows) {
  if (!rows.length) return;
  await (await col('governance_names')).bulkWrite(
    rows.map((r) => ({ updateOne: { filter: { address: r.address }, update: { $set: r }, upsert: true } })),
  );
}

/* ------------------------------------------------------------ Snapshot archive */

/** Archive ids: 0x… lowercased, legacy IPFS ids (Qm…) kept as-is (they are case-sensitive). */
const archiveId = (id) => (/^0x/i.test(String(id)) ? String(id).toLowerCase() : String(id));

const ARCHIVE_LIST_PROJECTION = { _id: 0, body: 0, strategies: 0, scoresByStrategy: 0, validation: 0, plugins: 0 };

async function upsertArchiveProposal(doc) {
  await (await col('governance_archive_proposals')).updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
}

/** Upsert votes in batches (bulkWrite works with both the driver and the mongo-proxy). */
async function upsertArchiveVotes(votes, batchSize = 1000) {
  const c = await col('governance_archive_votes');
  for (let i = 0; i < votes.length; i += batchSize) {
    const ops = votes.slice(i, i + batchSize).map((v) => ({
      updateOne: { filter: { id: v.id }, update: { $set: v }, upsert: true },
    }));
    if (ops.length) await c.bulkWrite(ops, { ordered: false });
  }
}

async function getArchiveProposal(id) {
  return (await col('governance_archive_proposals')).findOne({ id: archiveId(id) }, { projection: { _id: 0 } });
}

async function listArchiveProposals({ limit = 50, skip = 0 } = {}) {
  return (await col('governance_archive_proposals'))
    .find({}, { projection: ARCHIVE_LIST_PROJECTION })
    .sort({ created: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/** id → { votes, votesDigest, state } for every archived proposal (re-run skip check). */
async function archiveIndex() {
  const rows = await (await col('governance_archive_proposals'))
    .find({}, { projection: { _id: 0, id: 1, votes: 1, archivedVotes: 1, votesDigest: 1, state: 1 } })
    .toArray();
  return new Map(rows.map((r) => [r.id, r]));
}

async function listArchiveVotes(proposalId, { limit = 100, skip = 0 } = {}) {
  return (await col('governance_archive_votes'))
    .find({ proposalId: archiveId(proposalId) }, { projection: { _id: 0 } })
    .sort({ vp: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

async function getArchiveVote(proposalId, voter) {
  return (await col('governance_archive_votes')).findOne(
    { proposalId: archiveId(proposalId), voter: String(voter).toLowerCase() },
    { projection: { _id: 0 } },
  );
}

async function listArchiveVotedProposalIds(voter) {
  const rows = await (await col('governance_archive_votes'))
    .find({ voter: String(voter).toLowerCase() }, { projection: { _id: 0, proposalId: 1 } })
    .toArray();
  return rows.map((r) => r.proposalId);
}

async function setArchiveSpace(space) {
  await (await col('governance_archive_meta')).updateOne({ key: 'space' }, { $set: { key: 'space', space } }, { upsert: true });
}

async function getArchiveSpace() {
  return (await (await col('governance_archive_meta')).findOne({ key: 'space' }, { projection: { _id: 0 } }))?.space || null;
}

/** Create the archive's indexes (idempotent; run by the import script). */
async function ensureArchiveIndexes() {
  const proposals = await col('governance_archive_proposals');
  const votes = await col('governance_archive_votes');
  await proposals.createIndex({ id: 1 }, { unique: true });
  await proposals.createIndex({ created: -1 });
  await votes.createIndex({ id: 1 }, { unique: true });
  await votes.createIndex({ proposalId: 1, vp: -1 });
  await votes.createIndex({ voter: 1, proposalId: 1 });
}

module.exports = {
  PREFIX,
  setArchiveSpace,
  getArchiveSpace,
  upsertArchiveProposal,
  upsertArchiveVotes,
  getArchiveProposal,
  listArchiveProposals,
  archiveIndex,
  listArchiveVotes,
  getArchiveVote,
  listArchiveVotedProposalIds,
  ensureArchiveIndexes,
  hasVotes,
  getProposer,
  getProposerRecord,
  listProposers,
  setProposer,
  setVoteReveal,
  collection: col,
  insertProposal,
  getProposal,
  listProposals,
  updateProposal,
  saveFrozen,
  getFrozen,
  getVote,
  upsertVoteIfNewer,
  listVotes,
  getNames,
  setNames,
  listVotedProposalIds,
  setVoteGroveUri,
};
