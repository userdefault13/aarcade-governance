const test = require('node:test');
const assert = require('node:assert/strict');
const { editableFields, canCancel, canPropose, canSignIn, TEXT_FIELDS, BALLOT_FIELDS } = require('../../lib/governance/permissions.cjs');

const AUTHOR = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const proposal = { id: '0x1', author: AUTHOR, category: 'sigprop' };
const ballot = { id: '0x2', author: OTHER, electionId: 'steward-2026' };

const member = (wallet) => ({ wallet, owner: false, staff: false, member: true });
const staff = (wallet) => ({ wallet, owner: false, staff: true, member: false });
const owner = { wallet: '0x00000000000000000000000000000000000000ff', owner: true, staff: false, member: false };
const nobody = (wallet) => ({ wallet, owner: false, staff: false, member: false });

const ALL = [...TEXT_FIELDS, ...BALLOT_FIELDS];

test('canPropose: whitelist (member) or owner only; staff just sign in for ballots', () => {
  assert.equal(canPropose(owner), true);
  assert.equal(canPropose(member(OTHER)), true);
  assert.equal(canPropose(staff(OTHER)), false);
  assert.equal(canPropose(nobody(OTHER)), false);
  assert.equal(canSignIn(staff(OTHER)), true);
  assert.equal(canSignIn(nobody(OTHER)), false);
});

test('author edits everything while pending with no votes', () => {
  const r = editableFields(proposal, member(AUTHOR), { state: 'pending', hasVotes: false });
  assert.deepEqual(r, { ok: true, fields: ALL });
});

test('author cannot edit once voting started or votes exist', () => {
  assert.equal(editableFields(proposal, member(AUTHOR), { state: 'active', hasVotes: false }).status, 409);
  assert.equal(editableFields(proposal, member(AUTHOR), { state: 'pending', hasVotes: true }).status, 409);
});

test('other members and staff cannot edit someone else’s proposal', () => {
  assert.equal(editableFields(proposal, member(OTHER), { state: 'pending', hasVotes: false }).status, 403);
  assert.equal(editableFields(proposal, staff(OTHER), { state: 'pending', hasVotes: false }).status, 403);
});

test('a removed member loses edit and cancel rights on their own proposal', () => {
  assert.equal(editableFields(proposal, nobody(AUTHOR), { state: 'pending', hasVotes: false }).status, 403);
  assert.equal(canCancel(proposal, nobody(AUTHOR), { state: 'pending' }).status, 403);
});

test('owner edits any proposal: everything while pending, text only once live', () => {
  assert.deepEqual(editableFields(proposal, owner, { state: 'pending', hasVotes: false }).fields, ALL);
  assert.deepEqual(editableFields(proposal, owner, { state: 'active', hasVotes: true }).fields, TEXT_FIELDS);
});

test('nobody edits closed or cancelled proposals', () => {
  assert.equal(editableFields(proposal, owner, { state: 'closed', hasVotes: true }).status, 409);
  assert.equal(editableFields(proposal, owner, { state: 'cancelled', hasVotes: false }).status, 409);
});

test('election ballots are not editable here', () => {
  assert.equal(editableFields(ballot, staff(OTHER), { state: 'pending', hasVotes: false }).status, 403);
});

test('cancel: author, owner; not other members', () => {
  assert.equal(canCancel(proposal, member(AUTHOR), { state: 'active' }).ok, true);
  assert.equal(canCancel(proposal, owner, { state: 'active' }).ok, true);
  assert.equal(canCancel(proposal, member(OTHER), { state: 'active' }).status, 403);
  assert.equal(canCancel(proposal, staff(OTHER), { state: 'active' }).status, 403);
  assert.equal(canCancel(proposal, owner, { state: 'closed' }).status, 409);
  assert.equal(canCancel(proposal, owner, { state: 'cancelled' }).status, 409);
});

test('cancel election ballots: any staff or the owner', () => {
  assert.equal(canCancel(ballot, staff(AUTHOR), { state: 'active' }).ok, true);
  assert.equal(canCancel(ballot, owner, { state: 'active' }).ok, true);
  assert.equal(canCancel(ballot, member(OTHER), { state: 'active' }).status, 403);
});
