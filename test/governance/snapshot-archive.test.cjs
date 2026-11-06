/**
 * Snapshot → Aarcade archive: hub paging, normalisation, digests, and the read API.
 * The hub is faked; Mongo is in-memory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.GOVERNANCE_GROVE = '0';
const { installMemoryMongo } = require('./_memoryMongo.cjs');
installMemoryMongo();

const archive = require('../../lib/governance/snapshotArchive.cjs');
const store = require('../../lib/governance/store.cjs');

const VOTER = '0x00000000000000000000000000000000000000a1';
const HEX_ID = `0x${'ab'.repeat(32)}`;
const IPFS_ID = 'QmScSnruHGnJ3mfQichzACYBH7gu5tpPQQRJxNbgB5bkAe';

/** 2,600 votes on the hex proposal; 1,500 share one timestamp so pages split mid-second. */
function hubVotes(proposalId) {
  if (proposalId !== HEX_ID.toUpperCase().replace('0X', '0x') && proposalId !== HEX_ID) {
    return [{ id: 'QmVote1', ipfs: 'QmVote1', voter: VOTER.toUpperCase().replace('0X', '0x'), created: 1600000000, choice: 2, reason: 'old', vp: 5, vp_by_strategy: [5], vp_state: 'final', app: null, metadata: {} }];
  }
  return Array.from({ length: 2600 }, (_, i) => ({
    id: `0x${String(i).padStart(64, '0')}`,
    ipfs: `bafy${i}`,
    voter: i === 7 ? VOTER : `0x${String(i + 1).padStart(40, '0')}`,
    created: 1700000000 + (i < 1500 ? 0 : i),
    choice: { 1: 1 },
    reason: '',
    vp: 2600 - i,
    vp_by_strategy: [2600 - i],
    vp_state: 'final',
    app: 'snapshot',
    metadata: {},
  }));
}

const HUB_PROPOSALS = [
  { id: IPFS_ID, ipfs: IPFS_ID, author: '0xAuthor00000000000000000000000000000000001', created: 1600000000, title: '[SIGPROP] Old one', body: 'b', choices: ['Yes', 'No'], start: 1, end: 2, state: 'closed', type: 'single-choice', scores: [0, 5], scores_total: 5, votes: 1, quorum: 0, strategies: [] },
  { id: HEX_ID.toUpperCase().replace('0X', '0x'), ipfs: 'bafyP', author: '0xAuthor00000000000000000000000000000000002', created: 1700000000, title: '[AGIP 1] New one', body: 'body', choices: ['For', 'Against'], start: 1, end: 2, state: 'closed', type: 'weighted', scores: [3, 1], scores_total: 4, votes: 2600, quorum: 1, strategies: [{ name: 'erc20' }] },
];

function fakeHub() {
  let calls = 0;
  const query = async (q, vars) => {
    calls++;
    if (q.includes('proposals(')) return { proposals: HUB_PROPOSALS.slice(vars.skip, vars.skip + vars.first) };
    if (q.includes('votes(')) {
      const all = hubVotes(vars.proposal).sort((a, b) => a.created - b.created);
      return { votes: all.filter((v) => v.created >= vars.since).slice(vars.skip, vars.skip + vars.first) };
    }
    if (q.includes('space(')) return { space: { id: 'aavegotchi.eth', name: 'Aavegotchi', proposalsCount: 2, votesCount: 2601, followersCount: 9 } };
    throw new Error(`unexpected query ${q}`);
  };
  return { query, calls: () => calls };
}

test('ids: 0x hashes lowercase, IPFS ids keep their case', () => {
  assert.equal(archive.normId('0xABC'), '0xabc');
  assert.equal(archive.normId(IPFS_ID), IPFS_ID);
});

test('digest is independent of vote order', () => {
  const a = [{ id: '1', vp: 1 }, { id: '2', vp: 2 }];
  assert.equal(archive.votesDigest(a), archive.votesDigest([...a].reverse()));
  assert.notEqual(archive.votesDigest(a), archive.votesDigest([{ id: '1', vp: 1 }]));
});

test('fetches every vote across pages that split a shared timestamp', async () => {
  const votes = await archive.fetchProposalVotes(fakeHub().query, HEX_ID);
  assert.equal(votes.length, 2600);
  assert.equal(new Set(votes.map((v) => v.id)).size, 2600);
});

test('archiveSpace stores proposals, votes and counts; re-runs skip what is complete', async () => {
  const hub = fakeHub();
  const sink = async ({ proposal, votes }) => {
    await store.upsertArchiveVotes(votes);
    await store.upsertArchiveProposal(proposal);
  };
  const stats = await archive.archiveSpace(sink, { query: hub.query });
  assert.deepEqual([stats.proposals, stats.votes, stats.mismatches.length], [2, 2601, 0]);

  const stored = await store.getArchiveProposal(HEX_ID);
  assert.equal(stored.id, HEX_ID, '0x id lowercased');
  assert.equal(stored.archivedVotes, 2600);
  assert.equal(stored.votesDigest, archive.votesDigest(await store.listArchiveVotes(HEX_ID, { limit: 5000 })));
  assert.equal((await store.getArchiveProposal(IPFS_ID)).title, '[SIGPROP] Old one');

  const existing = await store.archiveIndex();
  const rerun = await archive.archiveSpace(sink, {
    query: fakeHub().query,
    skip: (p) => existing.get(p.id)?.archivedVotes === p.votes && p.state === 'closed',
  });
  assert.deepEqual([rerun.proposals, rerun.skipped], [0, 2]);
});

test('vote count mismatches are reported', async () => {
  const hub = fakeHub();
  const short = async (q, vars) => {
    const data = await hub.query(q, vars);
    if (data.votes && vars.proposal !== IPFS_ID) data.votes = data.votes.filter((v) => v.vp !== 1);
    return data;
  };
  const stats = await archive.archiveSpace(async () => {}, { query: short, only: [HEX_ID] });
  assert.deepEqual(stats.mismatches, [{ id: HEX_ID, expected: 2600, got: 2599 }]);
});

/* -------------------------------------------------------------- read API */

let handler;
test.before(async () => {
  ({ default: handler } = await import(path.join(__dirname, '../../api/governance.js')));
});

async function get(query) {
  let status = 200;
  let json;
  const res = {
    setHeader() {},
    status(s) {
      status = s;
      return res;
    },
    json(j) {
      json = j;
      return res;
    },
    end() {
      return res;
    },
  };
  await handler({ method: 'GET', query, headers: {} }, res);
  return { status, json };
}

test('archive API: list, detail with votes by VP, voter lookups, space', async () => {
  await store.setArchiveSpace({ id: 'aavegotchi.eth', name: 'Aavegotchi', followersCount: 9 });

  const list = await get({ action: 'archive', limit: '10' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.proposals.map((p) => p.id), [HEX_ID, IPFS_ID], 'newest first');
  assert.equal(list.json.proposals[0].body, undefined, 'list omits body');
  assert.equal(list.json.proposals[0].source, 'snapshot');

  const detail = await get({ action: 'archive-proposal', id: IPFS_ID });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.proposal.body, 'b');
  assert.deepEqual(detail.json.results.scores, [0, 5]);

  const top = await get({ action: 'archive-proposal', id: HEX_ID, limit: '3' });
  assert.deepEqual(top.json.votes.map((v) => v.vp), [2600, 2599, 2598], 'votes sorted by VP');

  assert.equal((await get({ action: 'archive-proposal', id: 'not-an-id' })).status, 400);
  assert.equal((await get({ action: 'archive-proposal', id: `0x${'cd'.repeat(32)}` })).status, 404);

  const voted = await get({ action: 'voted', voter: VOTER });
  assert.deepEqual(new Set(voted.json.proposalIds), new Set([HEX_ID, IPFS_ID]));
  const mine = await get({ action: 'vote', id: IPFS_ID, voter: VOTER });
  assert.equal(mine.json.vote.reason, 'old');

  assert.equal((await get({ action: 'archive-space' })).json.space.followersCount, 9);
});
