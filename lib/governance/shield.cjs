/**
 * Shielded (blind) voting with drand timelock encryption (tlock).
 *
 * A shielded proposal is locked to the drand round that fires when voting closes. Voters
 * encrypt their choice to that round in the browser, so nobody — other voters, admins,
 * or whoever runs this server — can read choices or a running tally while the vote is
 * open. Once drand (League of Entropy, quicknet: one round every 3s) publishes that
 * round's signature, the ciphertexts can be decrypted by anyone; there is no reveal
 * step for voters and no key held by us.
 *
 * Ciphertexts are age files with a `tlock <round> <chainHash>` stanza (armored).
 */
const MAX_CIPHERTEXT_LEN = 4096;
const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const ARMOR_END = '-----END AGE ENCRYPTED FILE-----';

let tlockModule = null;
let clientSingleton = null;

async function tlock() {
  tlockModule = tlockModule || (await import('tlock-js'));
  return tlockModule;
}

/** drand quicknet client (chain hash + public key pinned by tlock-js). */
async function client() {
  if (!clientSingleton) clientSingleton = (await tlock()).mainnetClient();
  return clientSingleton;
}

async function chainInfo() {
  return (await client()).chain().info();
}

/** Unix seconds at which `round` is published. */
function roundTimeSec(info, round) {
  return info.genesis_time + (round - 1) * info.period;
}

/**
 * First drand round published at or after `endSec` — votes become decryptable then.
 * @returns {Promise<{ round: number, chainHash: string, time: number }>}
 */
async function lockForEnd(endSec) {
  const info = await chainInfo();
  const round = Math.max(1, Math.ceil((endSec - info.genesis_time) / info.period) + 1);
  return { round, chainHash: info.hash, time: roundTimeSec(info, round) };
}

/**
 * Read the tlock stanza from an armored ciphertext without decrypting it.
 * @returns {{ round: number, chainHash: string } | null}
 */
function parseCiphertext(armored) {
  const s = String(armored || '').trim();
  if (!s || s.length > MAX_CIPHERTEXT_LEN || !s.startsWith(ARMOR_BEGIN) || !s.endsWith(ARMOR_END)) return null;
  const b64 = s.slice(ARMOR_BEGIN.length, -ARMOR_END.length).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  const header = Buffer.from(b64, 'base64').toString('latin1');
  if (!header.startsWith('age-encryption.org/v1\n')) return null;
  const m = header.match(/\n-> tlock (\d+) ([0-9a-f]{64})\n/);
  return m ? { round: Number(m[1]), chainHash: m[2] } : null;
}

/**
 * Shape check for a shielded vote's `choice` field.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function checkCiphertext(armored, lock) {
  const parsed = parseCiphertext(armored);
  if (!parsed) return { ok: false, error: 'shielded vote must be a tlock-encrypted choice' };
  if (parsed.chainHash !== lock.chainHash || parsed.round !== lock.round) {
    return { ok: false, error: `choice must be encrypted to drand round ${lock.round}` };
  }
  return { ok: true };
}

/**
 * Decrypt many ciphertexts locked to one round. Fetches (and verifies) the round's beacon
 * once; if drand is unreachable or the round isn't out yet this throws and nothing should
 * be marked. Per-ciphertext failures come back as { error } so bad ballots can be voided.
 * @param {string[]} ciphertexts
 * @param {{ round: number }} lock
 * @returns {Promise<Array<{ plaintext: string } | { error: string }>>}
 */
async function decryptAll(ciphertexts, lock) {
  const t = await tlock();
  const base = await client();
  const beacon = await base.get(lock.round); // throws on network error / not yet published
  const cached = new Proxy(base, {
    get(target, prop) {
      if (prop === 'get') return async (r) => (r === lock.round ? beacon : target.get(r));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const out = [];
  for (const ct of ciphertexts) {
    try {
      out.push({ plaintext: (await t.timelockDecrypt(ct, cached)).toString('utf8') });
    } catch (e) {
      out.push({ error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}

module.exports = { MAX_CIPHERTEXT_LEN, lockForEnd, parseCiphertext, checkCiphertext, decryptAll, chainInfo, roundTimeSec };
