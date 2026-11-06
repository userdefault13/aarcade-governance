/**
 * snapshotCompat: the Snapshot-hub GraphQL queries our server modules send, answered from
 * the archive plus live self-hosted governance. Queries are copied from those modules.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOVERNANCE_GROVE = '0';
delete process.env.SNAPSHOT_SOURCE;
const { installMemoryMongo } = require('./_memoryMongo.cjs');
installMemoryMongo();

const store = require('../../lib/governance/store.cjs');
const compat = require('../../lib/governance/snapshotCompat.cjs');

const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';
const OLD = 'QmScSnruHGnJ3mfQichzACYBH7gu5tpPQQRJxNbgB5bkAe';
const MID = `0x${'11'.repeat(32)}`;
const LIVE = `0x${'22'.repeat(32)}`;
const CANCELLED = `0x${'33'.repeat(32)}`;
const now = Math.floor(Date.now() / 1000);

const archived = (id, created, extra = {}) => ({
  id,
  space: 'aavegotchi.eth',
  author: ALICE,
  created,
  type: 'single-choice',
  title: `Archived ${created}`,
  body: 'old body',
  choices: ['Yes', 'No'],
  start: created,
  end: created + 100,
  quorum: 10,
  snapshot: 123,
  state: 'closed',
  scores: [7, 3],
  scoresTotal: 10,
  votes: 2,
  strategies: [],
  ...extra,
});

test.before(async () => {
  await store.setArchiveSpace({ id: 'aavegotchi.eth', name: 'Aavegotchi', proposalsCount: 2, votesCount: 3, followersCount: 50 });
  await store.upsertArchiveProposal(archived(OLD, 1_600_000_000));
  await store.upsertArchiveProposal(archived(MID, 1_700_000_000, { votes: 1, title: '[AGIP 9] Mid' }));
  await store.upsertArchiveVotes([
    { id: 'QmV1', proposalId: OLD, voter: ALICE, created: 1_600_000_010, choice: 1, reason: '', vp: 7, vpByStrategy: [7] },
    { id: 'QmV2', proposalId: OLD, voter: BOB, created: 1_600_000_020, choice: 2, reason: '', vp: 3, vpByStrategy: [3] },
    { id: '0xv3', proposalId: MID, voter: ALICE, created: 1_700_000_010, choice: 1, reason: 'yes', vp: 5, vpByStrategy: [5] },
  ]);
  const live = (id, extra) => ({
    id,
    space: 'aavegotchi-dao',
    author: BOB,
    title: 'Live SigProp',
    body: 'live body',
    choices: ['For', 'Against'],
    type: 'weighted',
    start: now - 100,
    end: now + 1000,
    snapshot: 999,
    quorum: 1,
    strategies: [],
    privacy: 'none',
    category: 'sigprop',
    created: now - 200,
    cancelled: false,
    ...extra,
  });
  await store.insertProposal(live(LIVE));
  await store.insertProposal(live(CANCELLED, { cancelled: true, title: 'Gone' }));
  await (await store.collection('governance_votes')).insertOne({
    proposalId: LIVE,
    voter: ALICE,
    choice: { 1: 1 },
    reason: 'live',
    app: 'aarcade-gh-t',
    timestamp: now - 50,
    vp: 42,
    vpByStrategy: [42],
  });
  compat.resetCache();
});

test('space header counts archive plus live proposals and votes', async () => {
  const data = await compat.query(`query { space(id: "aavegotchi.eth") { name proposalsCount votesCount followersCount } }`);
  assert.deepEqual(data.space, { name: 'Aavegotchi', proposalsCount: 3, votesCount: 4, followersCount: 50 });
});

test('catalog: proposals by space, newest first, cancelled live ones left out', async () => {
  const data = await compat.query(
    `query Proposals($first: Int!) {
      proposals(first: $first, skip: 0, where: { space: "aavegotchi.eth" }, orderBy: "created", orderDirection: desc) {
        id title state start end
      }
    }`,
    { first: 10 },
  );
  assert.deepEqual(data.proposals.map((p) => p.id), [LIVE, MID, OLD]);
  assert.equal(data.proposals[0].state, 'active');
});

test('catalog: proposals by id_in, IPFS ids case-sensitive', async () => {
  const data = await compat.query(
    `query Props($ids: [String!]!) { proposals(first: 100, where: { id_in: $ids }) { id title } }`,
    { ids: [OLD, MID.toUpperCase().replace('0X', '0x'), OLD.toLowerCase()] },
  );
  assert.deepEqual(data.proposals.map((p) => p.id).sort(), [MID, OLD].sort());
});

test('poll: active proposals ordered by end', async () => {
  const data = await compat.query(
    `query ActiveProposals($first: Int!, $where: ProposalWhere) {
      proposals(first: $first, skip: 0, where: $where, orderBy: "end", orderDirection: asc) { id title state end scores_total quorum }
    }`,
    { first: 50, where: { space_in: ['aavegotchi.eth'], state: 'active' } },
  );
  assert.deepEqual(data.proposals.map((p) => [p.id, p.scores_total]), [[LIVE, 42]]);
});

test('XP merkle: proposal details and every voter, archived and live', async () => {
  const detail = await compat.query(`query Prop($id: String!) { proposal(id: $id) { id title votes snapshot } }`, { id: OLD });
  assert.deepEqual(detail.proposal, { id: OLD, title: 'Archived 1600000000', votes: 2, snapshot: '123' });

  const votesQ = `query Votes($proposal: String!, $first: Int!, $skip: Int!) {
    votes(first: $first, skip: $skip, where: { proposal: $proposal }) { voter choice }
  }`;
  const old = await compat.query(votesQ, { proposal: OLD, first: 1000, skip: 0 });
  assert.deepEqual(old.votes.map((v) => v.voter).sort(), [ALICE, BOB]);
  const live = await compat.query(votesQ, { proposal: LIVE, first: 1000, skip: 0 });
  assert.deepEqual(live.votes, [{ voter: ALICE, choice: { 1: 1 } }]);
  const paged = await compat.query(votesQ, { proposal: OLD, first: 1, skip: 1 });
  assert.equal(paged.votes.length, 1);
});

test('airdrops: a voter across archived and live proposals', async () => {
  const data = await compat.query(
    `query Votes($voter: String!, $proposalIds: [String!]!) {
      votes(first: 1000, where: { voter: $voter, proposal_in: $proposalIds }) { proposal { id } choice }
    }`,
    { voter: ALICE.toUpperCase().replace('0X', '0x'), proposalIds: [OLD, MID, LIVE] },
  );
  assert.deepEqual(data.votes.map((v) => v.proposal.id).sort(), [LIVE, MID, OLD].sort());
});

test('quorum index: votes in a time window, oldest first', async () => {
  const data = await compat.query(
    `query ($space: String!, $since: Int!, $until: Int!, $first: Int!, $skip: Int!) {
      votes(first: $first, skip: $skip, orderBy: "created", orderDirection: asc,
        where: { space: $space, created_gte: $since, created_lte: $until }) { id voter created }
    }`,
    { space: 'aavegotchi.eth', since: 1_600_000_015, until: now, first: 1000, skip: 0 },
  );
  assert.deepEqual(data.votes.map((v) => v.created), [1_600_000_020, 1_700_000_010, now - 50]);
  const other = await compat.query(`query { votes(where: { space: "other.eth" }) { id } }`);
  assert.deepEqual(other.votes, []);
});

test('profile activity: voter history with nested proposal and space', async () => {
  const data = await compat.query(
    `query VoterHistory($where: VoteWhere!, $first: Int!) {
      votes(first: $first, orderBy: "created", orderDirection: desc, where: $where) {
        id choice created proposal { id title choices space { id name } }
      }
    }`,
    { where: { voter: ALICE, space: 'aavegotchi.eth' }, first: 100 },
  );
  assert.deepEqual(data.votes.map((v) => v.proposal.id), [LIVE, MID, OLD]);
  assert.equal(data.votes[2].proposal.space.name, 'Aavegotchi');
});

test('unknown fields fail like the hub would', async () => {
  await assert.rejects(compat.query(`query { proposals { nope } }`), /Cannot query field/);
});
