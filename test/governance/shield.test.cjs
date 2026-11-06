const test = require('node:test');
const assert = require('node:assert/strict');
const SPACE = require('../../lib/governance/space.config.cjs');
const shield = require('../../lib/governance/shield.cjs');
const { checkVote, hiddenTally, proposalId } = require('../../lib/governance/votes.cjs');

// Offline: encrypting only needs the chain's public info (bundled with tlock-js).
async function encrypt(round, text) {
  const t = await import('tlock-js');
  const info = t.defaultChainInfo;
  const stub = { chain: () => ({ info: async () => info }) };
  return { ct: await t.timelockEncrypt(round, Buffer.from(text), stub), info };
}

const NOW = 1_800_000_000;

test('parseCiphertext reads the round and chain hash from the tlock stanza', async () => {
  const { ct, info } = await encrypt(42_000_000, '{"1":1}');
  assert.deepEqual(shield.parseCiphertext(ct), { round: 42_000_000, chainHash: info.hash });
  assert.equal(shield.parseCiphertext('{"1":1}'), null);
  assert.equal(shield.parseCiphertext(`${ct}${'x'.repeat(5000)}`), null);
});

test('shielded checkVote accepts a ciphertext for the proposal round only', async () => {
  const { ct, info } = await encrypt(42_000_000, '[1,2]');
  const { ct: wrongRound } = await encrypt(42_000_001, '[1,2]');
  const proposal = {
    id: proposalId({ t: 'shielded' }).toLowerCase(),
    type: 'ranked-choice',
    choices: ['A', 'B'],
    start: NOW - 10,
    end: NOW + 10,
    quorum: 1,
    privacy: 'shielded',
    tlock: { round: 42_000_000, chainHash: info.hash, time: NOW + 12 },
  };
  const msg = (over) => ({
    from: '0x0000000000000000000000000000000000000001',
    space: SPACE.id,
    proposal: proposal.id,
    choice: ct,
    reason: '',
    app: 'test',
    timestamp: NOW,
    ...over,
  });
  const ok = checkVote(msg(), proposal, { now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.choice, null);
  assert.equal(ok.encrypted, true);
  assert.equal(checkVote(msg({ choice: '[1,2]' }), proposal, { now: NOW }).status, 400, 'plaintext rejected');
  assert.equal(checkVote(msg({ choice: wrongRound }), proposal, { now: NOW }).status, 400, 'other round rejected');
  assert.equal(checkVote(msg({ reason: 'A is best' }), proposal, { now: NOW }).status, 400, 'public reason rejected');
});

test('hiddenTally exposes turnout but no per-choice scores', () => {
  const r = hiddenTally({ quorum: 100 }, [{ vp: 60 }, { vp: 50 }]);
  assert.deepEqual(r, { scoresTotal: 110, votes: 2, quorum: 100, quorumReached: true, scores: null, hidden: true });
});
