/**
 * Governance use-cases: create proposal, cast vote, results, voter VP.
 * Storage in store.cjs, crypto/tally in votes.cjs, VP in votingPower.cjs.
 */
const SPACE = require('./space.config.cjs');
const store = require('./store.cjs');
const grove = require('./grove.cjs');
const shield = require('./shield.cjs');
const { getVotingPower, freezeSubgraphStrategies } = require('./votingPower.cjs');
const permissions = require('./permissions.cjs');
const { normalizeDiscussion } = require('./links.cjs');
const {
  VOTE_TYPES,
  proposalId,
  checkVote,
  verifyVoteSignature,
  tally,
  hiddenTally,
  validateChoice,
} = require('./votes.cjs');

const MAX_CHOICES = 20;
const MAX_TITLE = 256;
const MAX_BODY = 50_000;
const now = () => Math.floor(Date.now() / 1000);

const fail = (status, error) => ({ ok: false, status, error });

function proposalState(p, t = now()) {
  if (p.cancelled) return 'cancelled';
  if (t < p.start) return 'pending';
  if (t > p.end) return 'closed';
  return 'active';
}

/** Can this admin-users record create proposals? Mirrors canAccessAdminDao. */
function canPropose(admin) {
  const type = String(admin?.userType || '').toLowerCase();
  return SPACE.proposerUserTypes.includes(type);
}

/**
 * Validate the ballot-defining fields shared by create and edit.
 * @returns {{ ok: true, value: object } | { ok: false, status: number, error: string }}
 */
function validateBallot(input) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '');
  const choices = (input.choices || []).map((c) => String(c).trim());
  const start = Number(input.start);
  const end = Number(input.end);

  if (!title || title.length > MAX_TITLE) return fail(400, `title required (≤ ${MAX_TITLE} chars)`);
  if (body.length > MAX_BODY) return fail(400, 'body too long');
  if (!SPACE.votingTypes.includes(input.type)) return fail(400, `type must be one of ${SPACE.votingTypes.join(', ')}`);
  if (choices.length < 2 || choices.length > MAX_CHOICES || choices.some((c) => !c)) {
    return fail(400, `2–${MAX_CHOICES} non-empty choices required`);
  }
  if (new Set(choices).size !== choices.length) return fail(400, 'choices must be unique');
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return fail(400, 'start < end (unix seconds) required');
  if (end <= now()) return fail(400, 'end must be in the future');
  const privacy = input.privacy || 'none';
  if (!SPACE.privacyModes.includes(privacy)) return fail(400, `privacy must be one of ${SPACE.privacyModes.join(', ')}`);
  const category = input.category ? String(input.category) : '';
  if (category && !SPACE.categories.some((c) => c.id === category)) {
    return fail(400, `category must be one of ${SPACE.categories.map((c) => c.id).join(', ')}`);
  }
  // Poll category ⇔ one-wallet-one-vote type.
  if (category === 'poll' && input.type !== 'poll') return fail(400, "a Poll uses voting type 'poll' (one wallet, one vote)");
  if (input.type === 'poll' && category !== 'poll') return fail(400, "voting type 'poll' is only for the Poll category");
  const links = normalizeDiscussion(input.discussion);
  if (!links.ok) return fail(400, links.error);
  const discussion = links.value;
  const rawSigprop = category === 'agip' ? String(input.sigpropId || '').trim() : '';
  // 0x… ids compare case-insensitively; archived Snapshot IPFS ids (Qm…) are case-sensitive.
  const sigpropId = /^0x/i.test(rawSigprop) ? rawSigprop.toLowerCase() : rawSigprop;
  return { ok: true, value: { title, body, choices, type: input.type, start, end, privacy, category, discussion, sigpropId } };
}

const SIGPROP_TITLE = /\[(SIGPROP|Signal Proposal)\]/i;

/**
 * A Core AGIP must come with the SigProp it grew out of: one of ours (category sigprop) or a
 * legacy one in the Snapshot archive (tagged [SIGPROP] in its title). Cancelled ones don't count.
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
async function checkSigpropLink({ category, sigpropId }) {
  if (category !== 'agip') return { ok: true };
  if (!/^(0x[0-9a-f]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(sigpropId)) {
    return fail(400, 'a Core AGIP needs its SigProp — pick the SigProp it comes from');
  }
  const ours = await store.getProposal(sigpropId);
  if (ours) {
    if (ours.category !== 'sigprop') return fail(400, 'sigpropId must point at a SigProp');
    if (ours.cancelled) return fail(400, 'that SigProp was cancelled');
    return { ok: true };
  }
  const legacy = await store.getArchiveProposal(sigpropId);
  if (legacy && SIGPROP_TITLE.test(legacy.title || '')) return { ok: true };
  return fail(400, legacy ? 'sigpropId must point at a SigProp' : 'SigProp not found');
}

/** Shielded: lock votes to the drand round that fires when voting closes. */
async function tlockFor(privacy, end) {
  if (privacy !== 'shielded') return { ok: true, tlock: null };
  try {
    return { ok: true, tlock: await shield.lockForEnd(end) };
  } catch (e) {
    return fail(503, `drand unreachable — cannot create a shielded proposal right now (${e?.message || e})`);
  }
}

/**
 * @param {{ author: string, title: string, body?: string, choices: string[], type: string,
 *           start: number, end: number, discussion?: string, electionId?: string,
 *           category?: 'sigprop' | 'agip', privacy?: 'none' | 'shielded' }} input
 */
async function createProposal(input) {
  const checked = validateBallot(input);
  if (!checked.ok) return checked;
  const { title, body, choices, start, end, privacy, category, discussion, sigpropId } = checked.value;
  const electionId = input.electionId ? String(input.electionId) : '';
  if (!electionId && !category) return fail(400, 'category required (sigprop, agip or poll)');
  const link = await checkSigpropLink(checked.value);
  if (!link.ok) return link;
  if (electionId) {
    const live = (await store.listProposals({ electionId, limit: 20 })).find((p) => !p.cancelled);
    if (live) return fail(409, `election ${electionId} already has a live vote (${live.id}); cancel it first`);
  }

  const locked = await tlockFor(privacy, end);
  if (!locked.ok) return locked;
  const { tlock } = locked;

  // Freeze subgraph-sourced VP now; its block is the proposal's snapshot block.
  const { block, frozen } = await freezeSubgraphStrategies(SPACE);

  const fields = {
    space: SPACE.id,
    author: String(input.author).toLowerCase(),
    title,
    body,
    choices,
    type: input.type,
    start,
    end,
    snapshot: block,
    quorum: input.type === 'poll' ? SPACE.pollQuorum : SPACE.quorum,
    strategies: SPACE.strategies.map(({ name, params }) => ({ name, params })),
    discussion,
    electionId,
    category,
    sigpropId,
    privacy,
    tlock,
    created: now(),
  };
  const id = proposalId(fields).toLowerCase();

  const frozenUris = {};
  for (const [strategy, scores] of Object.entries(frozen)) {
    frozenUris[strategy] = await grove.uploadJson({ proposal: id, strategy, block, scores });
    await store.saveFrozen(id, strategy, block, scores, frozenUris[strategy]);
  }
  const groveUri = await grove.uploadJson({ id, ...fields, frozen: frozenUris });

  const doc = { id, ...fields, groveUri, frozenUris, lensPostId: null, cancelled: false };
  await store.insertProposal(doc);
  return { ok: true, proposal: doc };
}

/** Scores for voters at a proposal's snapshot (frozen subgraph VP + on-chain at its block). */
async function proposalVp(proposal, voters) {
  const frozen = await store.getFrozen(proposal.id);
  return getVotingPower(voters, { block: proposal.snapshot, frozen });
}

/**
 * @param {{ message: object, signature: string }} input
 */
async function castVote({ message, signature }) {
  if (!signature || typeof signature !== 'string') return fail(400, 'signature required');
  const proposal = message?.proposal ? await store.getProposal(message.proposal) : null;
  const check = checkVote(message, proposal);
  if (!check.ok) return check;

  if (!(await verifyVoteSignature(message, signature))) return fail(401, 'signature does not match message.from');

  const voter = String(message.from).toLowerCase();
  const { scores } = await proposalVp(proposal, [voter]);
  const { total, byStrategy } = scores[voter];
  if (total < SPACE.minVoteVp) return fail(403, `no voting power at block ${proposal.snapshot}`);

  const doc = {
    proposalId: proposal.id,
    voter,
    choice: check.choice,
    choiceEncrypted: check.encrypted ? String(message.choice) : null,
    reason: String(message.reason),
    app: String(message.app),
    timestamp: Number(message.timestamp),
    vp: total,
    vpByStrategy: byStrategy,
    message,
    signature,
    received: now(),
    groveUri: null,
  };
  if (!(await store.upsertVoteIfNewer(doc))) return fail(409, 'a newer vote from this wallet is already recorded');

  // Public audit copy: the exact signed payload, verifiable by anyone.
  const groveUri = await grove.uploadJson({
    domain: SPACE.eip712Domain,
    types: VOTE_TYPES,
    message,
    signature,
    vp: total,
    vpByStrategy: byStrategy,
    snapshot: proposal.snapshot,
  });
  if (groveUri) await store.setVoteGroveUri(proposal.id, voter, doc.timestamp, groveUri);

  return { ok: true, vote: { ...doc, groveUri } };
}

/**
 * Decrypt a closed shielded proposal's votes once its drand round is out, and persist the
 * reveal. Returns false while still sealed (open, round not out yet, or drand unreachable).
 */
async function revealIfDue(proposal, votes) {
  const t = now();
  if (t <= proposal.end || t < proposal.tlock.time) return false;
  const pending = votes.filter((v) => !v.revealed);
  if (!pending.length) return true;
  let plain;
  try {
    plain = await shield.decryptAll(pending.map((v) => v.choiceEncrypted), proposal.tlock);
  } catch (e) {
    console.warn('[governance] reveal deferred:', e?.message || e);
    return false;
  }
  await Promise.all(
    pending.map((v, i) => {
      const r = plain[i];
      let set;
      if (r.error) set = { revealed: true, choice: null, invalid: `could not decrypt: ${r.error}` };
      else {
        const c = validateChoice(proposal.type, r.plaintext, proposal.choices.length);
        set = c.ok ? { revealed: true, choice: c.choice, invalid: null } : { revealed: true, choice: null, invalid: c.error };
      }
      Object.assign(v, set);
      return store.setVoteReveal(proposal.id, v.voter, v.timestamp, set);
    }),
  );
  return true;
}

/** Tally, respecting shielded proposals: turnout only until revealed, then valid ballots. */
async function resultsFor(proposal) {
  const votes = await store.listVotes(proposal.id);
  if (proposal.privacy !== 'shielded') return { votes, results: tally(proposal, votes) };
  if (!(await revealIfDue(proposal, votes))) return { votes, results: hiddenTally(proposal, votes) };
  const valid = votes.filter((v) => v.revealed && !v.invalid);
  return {
    votes,
    results: { ...tally(proposal, valid), votes: votes.length, invalidVotes: votes.length - valid.length, revealed: true },
  };
}

async function getResults(id) {
  const proposal = await store.getProposal(id);
  if (!proposal) return fail(404, 'proposal not found');
  const { votes, results } = await resultsFor(proposal);
  return {
    ok: true,
    proposal: { ...proposal, state: proposalState(proposal) },
    results,
    votes: votes.map(({ message, signature, ...v }) => v),
  };
}

/** VP for one voter: at a proposal's snapshot if given, else now (subgraph head). */
async function voterVp(voter, proposalIdOrNull) {
  if (proposalIdOrNull) {
    const proposal = await store.getProposal(proposalIdOrNull);
    if (!proposal) return fail(404, 'proposal not found');
    const { block, scores } = await proposalVp(proposal, [voter]);
    return { ok: true, block, ...scores[voter], labels: SPACE.strategies.map((s) => s.label) };
  }
  const { block, scores } = await getVotingPower([voter]);
  return { ok: true, block, ...scores[voter], labels: SPACE.strategies.map((s) => s.label) };
}

/** List view: proposal fields + vote count / VP total (body omitted to keep it light). */
async function listProposals(opts) {
  const rows = await store.listProposals(opts);
  const proposals = await Promise.all(
    rows.map(async ({ body, strategies, ...p }) => {
      const { results } = await resultsFor(p);
      const { scoresTotal, votes, scores, hidden = false } = results;
      return { ...p, state: proposalState(p), votes, scoresTotal, scores, hidden };
    }),
  );
  return { ok: true, proposals };
}

/** Proposal ids this wallet voted on — live Aarcade votes plus the Snapshot archive. */
async function votedProposalIds(voter) {
  const [ours, archived] = await Promise.all([store.listVotedProposalIds(voter), store.listArchiveVotedProposalIds(voter)]);
  return { ok: true, proposalIds: [...new Set([...ours, ...archived])] };
}

/** A voter's current vote on a proposal (null if none); archived Snapshot proposals too. */
async function getVote(id, voter) {
  const v = await store.getVote(String(id).toLowerCase(), voter);
  if (!v) return { ok: true, vote: (await store.getArchiveVote(id, voter)) || null };
  const { message, signature, ...vote } = v;
  return { ok: true, vote };
}

/** Admin: attach the Lens discussion post (step 3). Cancelling goes through cancelProposal. */
async function updateProposalMeta(id, { lensPostId }) {
  const proposal = await store.getProposal(id);
  if (!proposal) return fail(404, 'proposal not found');
  const set = {};
  if (lensPostId !== undefined) set.lensPostId = lensPostId ? String(lensPostId) : null;
  if (!Object.keys(set).length) return fail(400, 'nothing to update');
  await store.updateProposal(proposal.id, set);
  return { ok: true, proposal: { ...proposal, ...set } };
}

/**
 * Edit a proposal. Authors may change everything until voting starts (and no one has voted);
 * after that only the Aarcade owner may edit, and only the text. The id never changes, and
 * each revision's record is uploaded to Grove like the original.
 * @param {{ wallet, owner, staff, member }} actor  from auth.authorizeActor
 */
async function editProposal(id, patch, actor) {
  const proposal = await store.getProposal(id);
  if (!proposal) return fail(404, 'proposal not found');
  const allowed = permissions.editableFields(proposal, actor, {
    state: proposalState(proposal),
    hasVotes: await store.hasVotes(proposal.id),
  });
  if (!allowed.ok) return allowed;

  const changed = Object.keys(patch).filter(
    (k) => [...permissions.TEXT_FIELDS, ...permissions.BALLOT_FIELDS].includes(k) && patch[k] !== undefined,
  );
  const blocked = changed.filter((k) => !allowed.fields.includes(k));
  if (blocked.length) return fail(409, `voting has started — ${blocked.join(', ')} can no longer change`);
  if (!changed.length) return fail(400, 'nothing to update');

  const merged = { ...proposal, ...Object.fromEntries(changed.map((k) => [k, patch[k]])) };
  const checked = validateBallot(merged);
  if (!checked.ok) return checked;
  if (!proposal.electionId && !checked.value.category) return fail(400, 'category required (sigprop, agip or poll)');
  const link = await checkSigpropLink(checked.value);
  if (!link.ok) return link;

  const set = Object.fromEntries(changed.map((k) => [k, checked.value[k]]));
  // Category or type changes carry their dependants: AGIP link, poll quorum.
  if (changed.includes('category') || changed.includes('sigpropId')) set.sigpropId = checked.value.sigpropId;
  if (changed.includes('type')) set.quorum = checked.value.type === 'poll' ? SPACE.pollQuorum : SPACE.quorum;
  if (set.privacy !== undefined || set.end !== undefined) {
    const locked = await tlockFor(checked.value.privacy, checked.value.end);
    if (!locked.ok) return locked;
    set.tlock = locked.tlock;
  }
  set.updated = now();
  set.updatedBy = actor.wallet;
  const next = { ...proposal, ...set };
  const { groveUri: _prev, revisions = [], ...record } = next;
  const groveUri = await grove.uploadJson({ ...record, revisionOf: proposal.groveUri || null });
  set.groveUri = groveUri;
  set.revisions = [...revisions, { at: set.updated, by: actor.wallet, fields: changed, groveUri: proposal.groveUri || null }];
  await store.updateProposal(proposal.id, set);
  return { ok: true, proposal: { ...proposal, ...set, state: proposalState({ ...proposal, ...set }) } };
}

/** Cancel: the author (while still a proposer), DAO staff for election ballots, or the Aarcade owner. */
async function cancelProposal(id, actor) {
  const proposal = await store.getProposal(id);
  if (!proposal) return fail(404, 'proposal not found');
  const allowed = permissions.canCancel(proposal, actor, { state: proposalState(proposal) });
  if (!allowed.ok) return allowed;
  const set = { cancelled: true, cancelledAt: now(), cancelledBy: actor.wallet };
  await store.updateProposal(proposal.id, set);
  return { ok: true, proposal: { ...proposal, ...set, state: 'cancelled' } };
}

async function listProposers() {
  return { ok: true, proposers: await store.listProposers(), owner: SPACE.ownerAddress };
}

async function addProposer({ address, label }, addedBy) {
  const wallet = String(address || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return fail(400, 'a 0x wallet address is required');
  await store.setProposer(wallet, {
    label: String(label || '').trim().slice(0, 80),
    active: true,
    addedBy,
    addedAt: now(),
  });
  return { ok: true, proposer: await store.getProposer(wallet) };
}

async function removeProposer(address, removedBy) {
  const wallet = String(address || '').trim().toLowerCase();
  if (!(await store.getProposer(wallet))) return fail(404, 'not a proposer');
  await store.setProposer(wallet, { active: false, removedBy, removedAt: now() });
  return { ok: true };
}

/* ------------------------------------------------------ Snapshot archive (read-only) */

/** Archived legacy Snapshot proposals, newest first (body omitted). */
async function listArchive({ limit = 50, skip = 0 } = {}) {
  const rows = await store.listArchiveProposals({ limit, skip });
  return { ok: true, proposals: rows.map((p) => ({ ...p, source: 'snapshot' })) };
}

async function archiveSpace() {
  return { ok: true, space: await store.getArchiveSpace() };
}

/** One archived proposal with Snapshot's final scores and a page of its votes (by VP). */
async function getArchive(id, { limit = 100, skip = 0 } = {}) {
  const proposal = await store.getArchiveProposal(id);
  if (!proposal) return fail(404, 'archived proposal not found');
  const votes = await store.listArchiveVotes(proposal.id, { limit, skip });
  return {
    ok: true,
    proposal: { ...proposal, source: 'snapshot' },
    results: {
      scores: proposal.scores,
      scoresTotal: proposal.scoresTotal,
      votes: proposal.votes,
      quorum: proposal.quorum,
      quorumReached: proposal.quorum ? proposal.scoresTotal >= proposal.quorum : null,
    },
    votes,
  };
}

module.exports = {
  canPropose,
  listArchive,
  getArchive,
  archiveSpace,
  editProposal,
  cancelProposal,
  listProposers,
  addProposer,
  removeProposer,
  createProposal,
  castVote,
  getResults,
  voterVp,
  listProposals,
  votedProposalIds,
  getVote,
  updateProposalMeta,
  proposalState,
};
