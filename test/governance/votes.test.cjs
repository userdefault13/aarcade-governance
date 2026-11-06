const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('ethers');
const SPACE = require('../../lib/governance/space.config.cjs');
const { VOTE_TYPES, proposalId, validateChoice, verifyVoteSignature, checkVote, tally } = require('../../lib/governance/votes.cjs');

const NOW = 1_800_000_000;
const proposal = {
  id: proposalId({ title: 't', created: NOW }).toLowerCase(),
  type: 'weighted',
  choices: ['Yes', 'No', 'Abstain'],
  start: NOW - 100,
  end: NOW + 100,
  quorum: 100,
};
const msg = (over = {}) => ({
  from: '0x0000000000000000000000000000000000000001',
  space: SPACE.id,
  proposal: proposal.id,
  choice: '{"1":1}',
  reason: '',
  app: 'test',
  timestamp: NOW,
  ...over,
});

test('proposal id is stable regardless of key order', () => {
  assert.equal(proposalId({ a: 1, b: [1, { c: 2, d: 3 }] }), proposalId({ b: [1, { d: 3, c: 2 }], a: 1 }));
});

test('EOA signature verifies and a tampered message does not', async () => {
  const w = Wallet.createRandom();
  const m = msg({ from: w.address });
  const sig = await w.signTypedData(SPACE.eip712Domain, VOTE_TYPES, m);
  assert.equal(await verifyVoteSignature(m, sig), true);
  // ecrecover gives another address; `from` is an EOA with no code → rejected without 1271.
  const tampered = { ...m, choice: '{"2":1}' };
  const ok = await verifyVoteSignature(tampered, sig).catch(() => false);
  assert.equal(ok, false);
});

test('weighted choice validation', () => {
  assert.deepEqual(validateChoice('weighted', '{"1":60,"2":40}', 3), { ok: true, choice: { 1: 60, 2: 40 } });
  assert.equal(validateChoice('weighted', '{"4":1}', 3).ok, false);
  assert.equal(validateChoice('weighted', '{"1":0}', 3).ok, false);
  assert.equal(validateChoice('weighted', '{"1":-1}', 3).ok, false);
  assert.equal(validateChoice('weighted', '[1]', 3).ok, false);
});

test('ranked choice validation requires a full ranking', () => {
  assert.equal(validateChoice('ranked-choice', '[2,1,3]', 3).ok, true);
  assert.equal(validateChoice('ranked-choice', '[2,1]', 3).ok, false);
  assert.equal(validateChoice('ranked-choice', '[2,2,1]', 3).ok, false);
  assert.equal(validateChoice('ranked-choice', '[0,1,2]', 3).ok, false);
});

test('checkVote enforces space, window and clock', () => {
  assert.equal(checkVote(msg(), proposal, { now: NOW }).ok, true);
  assert.equal(checkVote(msg({ space: 'other' }), proposal, { now: NOW }).status, 400);
  assert.equal(checkVote(msg(), proposal, { now: NOW + 101 }).status, 409);
  assert.equal(checkVote(msg(), proposal, { now: NOW - 101 }).status, 409);
  assert.equal(checkVote(msg({ timestamp: NOW - 3600 }), proposal, { now: NOW }).status, 400);
  assert.equal(checkVote(msg(), { ...proposal, cancelled: true }, { now: NOW }).status, 409);
  assert.equal(checkVote(msg(), null, { now: NOW }).status, 404);
});

test('weighted tally splits VP by weight', () => {
  const r = tally(proposal, [
    { choice: { 1: 3, 2: 1 }, vp: 100 },
    { choice: { 2: 1 }, vp: 50 },
  ]);
  assert.deepEqual(r.scores, [75, 75, 0]);
  assert.equal(r.scoresTotal, 150);
  assert.equal(r.quorumReached, true);
});

test('ranked choice runs instant runoff to a majority', () => {
  const p = { ...proposal, type: 'ranked-choice', choices: ['A', 'B', 'C'] };
  // First prefs: A 40, B 35, C 25 → C eliminated, its VP moves to B → B 60 wins.
  const r = tally(p, [
    { choice: [1, 2, 3], vp: 40 },
    { choice: [2, 1, 3], vp: 35 },
    { choice: [3, 2, 1], vp: 25 },
  ]);
  assert.equal(r.rounds.length, 2);
  assert.deepEqual(r.rounds[0], [40, 35, 25]);
  assert.deepEqual(r.scores, [40, 60, 0]);
  assert.equal(r.winner, 2);
});

test('ranked choice with an outright majority ends in one round', () => {
  const p = { ...proposal, type: 'ranked-choice', choices: ['A', 'B'] };
  const r = tally(p, [{ choice: [1, 2], vp: 70 }, { choice: [2, 1], vp: 30 }]);
  assert.equal(r.rounds.length, 1);
  assert.equal(r.winner, 1);
});
