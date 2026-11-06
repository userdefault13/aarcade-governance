const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryMongo } = require('./_memoryMongo.cjs');

installMemoryMongo();
const names = require('../../lib/governance/names.cjs');

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
let calls = 0;
names._lookups.basenames = async (list) => {
  calls += 1;
  return list.includes(A) ? { [A]: 'machete.base.eth' } : {};
};
names._lookups.ensNames = async (list) => (list.includes(A) || list.includes(B) ? { [A]: 'other.eth', [B]: 'oggysk.eth' } : {});

test('names: Basename wins over ENS, ENS fills the rest, none is empty', async () => {
  const r = await names.resolveNames([A.toUpperCase().replace('0X', '0x'), B, C, 'not-an-address']);
  assert.deepEqual(r, { ok: true, names: { [A]: 'machete.base.eth', [B]: 'oggysk.eth', [C]: '' } });
});

test('names: second lookup is served from the cache', async () => {
  const before = calls;
  const r = await names.resolveNames([A, B, C]);
  assert.equal(r.names[B], 'oggysk.eth');
  assert.equal(calls, before);
});

test('names: a failed lookup is not cached as "no name"', async () => {
  const D = '0x' + 'd'.repeat(40);
  const orig = names._lookups.ensNames;
  names._lookups.ensNames = async () => {
    throw new Error('rpc down');
  };
  assert.equal((await names.resolveNames([D])).names[D], '');
  names._lookups.ensNames = async () => ({ [D]: 'later.eth' });
  assert.equal((await names.resolveNames([D])).names[D], 'later.eth');
  names._lookups.ensNames = orig;
});

test('names: rejects names with spaces or control characters', async () => {
  const E = '0x' + 'e'.repeat(40);
  names._lookups.basenames = async () => ({ [E]: 'fake name\u0000.eth' });
  assert.equal((await names.resolveNames([E])).names[E], '');
});
