/**
 * Proposal lifecycle through the real api/governance.js handler, with Mongo replaced by an
 * in-memory stand-in and voting power stubbed: proposer sessions, roles, create / edit /
 * cancel permissions, and the admin Proposers endpoints.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Wallet } = require('ethers');

process.env.ADMIN_SESSION_SECRET = 'test-secret';
process.env.GOVERNANCE_GROVE = '0';
const OWNER = Wallet.createRandom();
process.env.GOVERNANCE_OWNER_ADDRESS = OWNER.address;

const { installMemoryMongo } = require('./_memoryMongo.cjs');
const mem = installMemoryMongo();
const ADMINS = mem.collection('admin_users');

const vpModule = require('../../lib/governance/votingPower.cjs');
vpModule.freezeSubgraphStrategies = async () => ({ block: 1, frozen: {} });
/** Per-wallet VP overrides (lowercase address → VP); everyone else has 10. */
const VP_BY = new Map();
vpModule.getVotingPower = async (addrs) => ({
  block: 1,
  scores: Object.fromEntries(addrs.map((a) => [a, { total: VP_BY.get(a) ?? 10, byStrategy: [VP_BY.get(a) ?? 10] }])),
});

const SPACE = require('../../lib/governance/space.config.cjs');
const { VOTE_TYPES } = require('../../lib/governance/votes.cjs');

/* ------------------------------------------------------------------- harness */

let handler;
test.before(async () => {
  ({ default: handler } = await import(path.join(__dirname, '../../api/governance.js')));
});

async function call(method, action, { body, token, query = {} } = {}) {
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
  await handler(
    { method, query: { action, ...query }, body, headers: token ? { authorization: `Bearer ${token}` } : {} },
    res,
  );
  return { status, json };
}

async function signIn(wallet) {
  const { json: msg } = await call('GET', 'session-message', { query: { wallet: wallet.address } });
  const signature = await wallet.signMessage(msg.message);
  return call('POST', 'session', { body: { wallet: wallet.address, issuedAt: msg.issuedAt, signature } });
}

async function adminToken(wallet) {
  const { issueAdminSession, createSessionMessage } = require('../../lib/adminSession.cjs');
  const msg = createSessionMessage(wallet.address);
  const { token } = await issueAdminSession({
    wallet: wallet.address,
    issuedAt: msg.issuedAt,
    signature: await wallet.signMessage(msg.message),
  });
  return token;
}

const now = () => Math.floor(Date.now() / 1000);
const draft = (over = {}) => ({
  category: 'sigprop',
  title: 'Fund the arcade',
  body: 'Because.',
  choices: ['For', 'Against'],
  type: 'weighted',
  start: now() + 3600,
  end: now() + 7 * 86400,
  ...over,
});

const STAFF = Wallet.createRandom();
const MEMBER = Wallet.createRandom();
const OTHER_MEMBER = Wallet.createRandom();
const STRANGER = Wallet.createRandom();

test('proposal lifecycle and permissions', async () => {
  await ADMINS.insertOne({ walletAddress: STAFF.address.toLowerCase(), userType: 'dao_council' });
  const staffAdmin = await adminToken(STAFF);

  // Strangers can't sign in as proposers.
  assert.equal((await signIn(STRANGER)).status, 403);

  // Staff can sign in (election ballots) but aren't proposers unless whitelisted.
  const staffSession = (await signIn(STAFF)).json;
  assert.ok(staffSession.token);
  const staffPropose = await call('POST', 'propose', { token: staffSession.token, body: draft() });
  assert.equal(staffPropose.status, 403, JSON.stringify(staffPropose.json));
  assert.equal((await call('GET', 'roles', { query: { wallet: STAFF.address } })).json.canPropose, false);

  // Hackathon council wallets land on the whitelist automatically and can propose.
  const COUNCIL = Wallet.createRandom();
  const LATE_COUNCIL = Wallet.createRandom();
  await ADMINS.insertOne({ walletAddress: COUNCIL.address.toLowerCase(), userType: 'hackathon_council' });
  await ADMINS.insertOne({ walletAddress: LATE_COUNCIL.address.toLowerCase(), userType: 'hackathon_council' });
  const synced = (await call('GET', 'proposers', { token: staffAdmin })).json.proposers;
  const autoRow = synced.find((p) => p.address === COUNCIL.address.toLowerCase());
  assert.equal(autoRow?.auto, true);
  const councilToken = (await signIn(COUNCIL)).json.token;
  const councilPropose = await call('POST', 'propose', { token: councilToken, body: draft({ title: 'Council idea' }) });
  assert.equal(councilPropose.status, 200, JSON.stringify(councilPropose.json));
  // Removed by the owner/staff → stays removed (no re-add on the next sync or sign-in).
  assert.equal((await call('POST', 'proposers-remove', { token: staffAdmin, body: { address: LATE_COUNCIL.address } })).status, 200);
  assert.equal((await call('GET', 'proposers', { token: staffAdmin })).json.proposers.some((p) => p.address === LATE_COUNCIL.address.toLowerCase()), false);
  const lateSession = (await signIn(LATE_COUNCIL)).json.token;
  assert.equal((await call('POST', 'propose', { token: lateSession, body: draft({ title: 'Nope' }) })).status, 403);

  // Staff adds two members on the Proposers tab; members can't manage the list.
  assert.equal((await call('POST', 'proposers-add', { token: staffAdmin, body: { address: MEMBER.address, label: 'Mia' } })).status, 200);
  assert.equal((await call('POST', 'proposers-add', { token: staffAdmin, body: { address: OTHER_MEMBER.address } })).status, 200);
  const { json: list } = await call('GET', 'proposers', { token: staffAdmin });
  assert.equal(list.proposers.length, 3); // Mia, the other member, and the auto-added council wallet
  assert.equal(list.owner, OWNER.address.toLowerCase());

  const roles = (await call('GET', 'roles', { query: { wallet: MEMBER.address } })).json;
  assert.deepEqual([roles.member, roles.canPropose, roles.owner], [true, true, false]);

  const member = (await signIn(MEMBER)).json.token;
  const other = (await signIn(OTHER_MEMBER)).json.token;
  const owner = (await signIn(OWNER)).json.token;
  assert.ok(member && other && owner);
  // A proposer session is not an admin session.
  assert.equal((await call('POST', 'proposers-add', { token: member, body: { address: STRANGER.address } })).status, 401);

  // Category is required for non-election proposals.
  assert.equal((await call('POST', 'propose', { token: member, body: draft({ category: '' }) })).status, 400);
  // Members can't create election ballots.
  assert.equal((await call('POST', 'propose', { token: member, body: draft({ electionId: 'steward-2026' }) })).status, 403);

  // The SigProp a later Core AGIP grows out of.
  const base = (await call('POST', 'propose', { token: member, body: draft({ title: 'Signal: fund the arcade' }) })).json.proposal;
  assert.ok(base?.id);

  const created = await call('POST', 'propose', { token: member, body: draft() });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.proposal.id;
  assert.equal(created.json.proposal.author, MEMBER.address.toLowerCase());

  // Listed by category; the other category is empty.
  assert.equal((await call('GET', 'proposals', { query: { category: 'sigprop' } })).json.proposals.length, 3);
  assert.equal((await call('GET', 'proposals', { query: { category: 'agip' } })).json.proposals.length, 0);

  // A Core AGIP must link its SigProp — a real one, not itself an AGIP.
  assert.equal((await call('POST', 'edit', { token: member, body: { id, category: 'agip' } })).status, 400);
  assert.equal((await call('POST', 'propose', { token: member, body: draft({ category: 'agip', sigpropId: `0x${'ab'.repeat(32)}` }) })).status, 400);

  // Author edits while pending; another member can't.
  const edited = await call('POST', 'edit', {
    token: member,
    body: { id, category: 'agip', sigpropId: base.id, choices: ['Yes', 'No', 'Abstain'] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.proposal.category, 'agip');
  assert.equal(edited.json.proposal.sigpropId, base.id);
  // An AGIP can't stand in for a SigProp.
  assert.equal((await call('POST', 'propose', { token: member, body: draft({ category: 'agip', sigpropId: id }) })).status, 400);
  assert.equal(edited.json.proposal.revisions.length, 1);
  assert.equal((await call('POST', 'edit', { token: other, body: { id, title: 'Hijacked' } })).status, 403);
  assert.equal((await call('POST', 'cancel', { token: other, body: { id } })).status, 403);

  // Open voting and cast a vote.
  assert.equal((await call('POST', 'edit', { token: member, body: { id, start: now() - 60 } })).status, 200);
  const message = {
    from: STRANGER.address,
    space: SPACE.id,
    proposal: id,
    choice: JSON.stringify({ 1: 1 }),
    reason: '',
    app: 'test',
    timestamp: now(),
  };
  const signature = await STRANGER.signTypedData(SPACE.eip712Domain, VOTE_TYPES, message);
  const voted = await call('POST', 'vote', { body: { message, signature } });
  assert.equal(voted.status, 200, JSON.stringify(voted.json));

  // Live with votes: the author can no longer edit; the owner can change text but not the ballot.
  assert.equal((await call('POST', 'edit', { token: member, body: { id, title: 'Late change' } })).status, 409);
  assert.equal((await call('POST', 'edit', { token: owner, body: { id, choices: ['A', 'B'] } })).status, 409);
  const ownerEdit = await call('POST', 'edit', { token: owner, body: { id, title: 'Fund the arcade (typo fixed)' } });
  assert.equal(ownerEdit.status, 200, JSON.stringify(ownerEdit.json));
  assert.equal(ownerEdit.json.proposal.updatedBy, OWNER.address.toLowerCase());

  // Owner cancels someone else's proposal; it can't be cancelled twice.
  assert.equal((await call('POST', 'cancel', { token: owner, body: { id } })).status, 200);
  assert.equal((await call('POST', 'cancel', { token: member, body: { id } })).status, 409);
  const { json: full } = await call('GET', 'proposal', { query: { id } });
  assert.equal(full.proposal.state, 'cancelled');

  // A removed member's session stops working on the next call.
  const second = (await call('POST', 'propose', { token: member, body: draft({ title: 'Second' }) })).json.proposal;
  assert.equal((await call('POST', 'proposers-remove', { token: staffAdmin, body: { address: MEMBER.address } })).status, 200);
  assert.equal((await call('POST', 'cancel', { token: member, body: { id: second.id } })).status, 403);
  // Staff can't cancel a member's proposal; the owner can.
  assert.equal((await call('POST', 'update', { token: staffAdmin, body: { id: second.id, cancelled: true } })).status, 403);
  assert.equal((await call('POST', 'cancel', { token: owner, body: { id: second.id } })).status, 200);
});

test('polls: one wallet, one vote; only in the Poll category', async () => {
  const POLLSTER = Wallet.createRandom();
  const LISTER = Wallet.createRandom();
  await ADMINS.insertOne({ walletAddress: LISTER.address.toLowerCase(), userType: 'dao_council' });
  const listerAdmin = await adminToken(LISTER);
  assert.equal((await call('POST', 'proposers-add', { token: listerAdmin, body: { address: POLLSTER.address } })).status, 200);
  const token = (await signIn(POLLSTER)).json.token;

  // Poll category ⇔ poll voting type.
  assert.equal((await call('POST', 'propose', { token, body: draft({ category: 'poll', type: 'weighted' }) })).status, 400);
  assert.equal((await call('POST', 'propose', { token, body: draft({ category: 'sigprop', type: 'poll' }) })).status, 400);

  const created = await call('POST', 'propose', {
    token,
    body: draft({ category: 'poll', type: 'poll', title: 'Pizza or tacos?', choices: ['Pizza', 'Tacos', 'Both'], start: now() - 60 }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const { id, quorum } = created.json.proposal;
  assert.equal(quorum, SPACE.pollQuorum);

  // Voting power differs wildly, but each wallet counts once.
  const vote = async (wallet, choice, vp) => {
    VP_BY.set(wallet.address.toLowerCase(), vp);
    const message = {
      from: wallet.address,
      space: SPACE.id,
      proposal: id,
      choice: JSON.stringify(choice),
      reason: '',
      app: 'test',
      timestamp: now(),
    };
    const signature = await wallet.signTypedData(SPACE.eip712Domain, VOTE_TYPES, message);
    return call('POST', 'vote', { body: { message, signature } });
  };
  {
    const [whale, a, b] = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
    assert.equal((await vote(whale, 1, 1_000_000)).status, 200);
    assert.equal((await vote(a, 2, 5)).status, 200);
    assert.equal((await vote(b, 2, 5)).status, 200);
    // A poll vote is one choice number, not a weighted split or a ranking.
    assert.equal((await vote(Wallet.createRandom(), { 1: 1 }, 5)).status, 400);
    assert.equal((await vote(Wallet.createRandom(), 4, 5)).status, 400);

    const { json } = await call('GET', 'proposal', { query: { id } });
    assert.deepEqual(json.results.scores, [1, 2, 0]);
    assert.equal(json.results.scoresTotal, 3);
    assert.equal(json.results.unit, 'voters');
    assert.equal(json.results.vpTotal, 1_000_010);
  }
});
