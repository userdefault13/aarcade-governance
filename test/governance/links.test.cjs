const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDiscussion, splitLinks } = require('../../lib/governance/links.cjs');

test('discussion: empty is allowed', () => {
  assert.deepEqual(normalizeDiscussion(''), { ok: true, value: '' });
  assert.deepEqual(normalizeDiscussion(undefined), { ok: true, value: '' });
});

test('discussion: up to 3 links split by ; (or spaces), deduped, stored joined', () => {
  const r = normalizeDiscussion(' https://a.example/x ;https://b.example/y;  https://a.example/x\nhttps://c.example ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'https://a.example/x ; https://b.example/y ; https://c.example');
  assert.deepEqual(splitLinks(r.value), ['https://a.example/x', 'https://b.example/y', 'https://c.example']);
});

test('discussion: more than 3 links is rejected', () => {
  const r = normalizeDiscussion('https://a.io;https://b.io;https://c.io;https://d.io');
  assert.equal(r.ok, false);
  assert.match(r.error, /at most 3/);
});

test('discussion: non-http links are rejected', () => {
  assert.equal(normalizeDiscussion('javascript:alert(1)').ok, false);
  assert.equal(normalizeDiscussion('https://ok.io ; forum.aavegotchi.com').ok, false);
  assert.equal(normalizeDiscussion(`https://x.io/${'a'.repeat(600)}`).ok, false);
});
