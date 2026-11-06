/**
 * Display names for voter addresses: Basename (primary name on Base, e.g. machete.base.eth)
 * first, then the ENS primary name on mainnet (e.g. oggysk.eth). Both are verified forward
 * — the name must resolve back to the address — so a wallet can't claim someone else's name.
 *
 * Batched (Multicall3 on Base, ENS ReverseRecords on mainnet) and cached in Mongo:
 * names for a day, "no name" for six hours.
 */
const { Contract, Interface, JsonRpcProvider, getAddress, namehash } = require('ethers');
const store = require('./store.cjs');

const MAX_BATCH = 500;
const CHUNK = 150;
const TTL_NAME = 24 * 60 * 60;
const TTL_NONE = 6 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

const BASE_L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ENS_REVERSE_RECORDS = '0x3671aE578E63FdF66ad4F3E12CC0c0d71Ac7510C';
/** ENSIP-19 reverse namespace for Base: coinType 0x80000000 | 8453. */
const BASE_REVERSE = '80002105.reverse';

const resolverIface = new Interface([
  'function name(bytes32) view returns (string)',
  'function addr(bytes32) view returns (address)',
]);
const MULTICALL_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[]) view returns ((bool success,bytes returnData)[])',
];

let providers = null;
function getProviders() {
  if (!providers) {
    const baseUrl = String(process.env.GOVERNANCE_RPC_URL || process.env.BASE_RPC_URL || '').trim() || 'https://mainnet.base.org';
    const ethUrl = String(process.env.SNAPSHOT_ETH_RPC_URL || '').trim() || 'https://ethereum-rpc.publicnode.com';
    providers = {
      base: new JsonRpcProvider(baseUrl, 8453, { staticNetwork: true }),
      eth: new JsonRpcProvider(ethUrl, 1, { staticNetwork: true }),
    };
  }
  return providers;
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function multicall(calls) {
  const mc = new Contract(MULTICALL3, MULTICALL_ABI, getProviders().base);
  return mc.aggregate3(calls.map((callData) => ({ target: BASE_L2_RESOLVER, allowFailure: true, callData })));
}

/** Basenames: reverse name, then check the name's addr() is this address. */
async function basenames(addresses) {
  const out = {};
  for (const part of chunks(addresses, CHUNK)) {
    const reverse = await multicall(
      part.map((a) => resolverIface.encodeFunctionData('name', [namehash(`${a.slice(2)}.${BASE_REVERSE}`)])),
    );
    const claimed = part
      .map((a, i) => {
        const r = reverse[i];
        if (!r.success || r.returnData === '0x') return null;
        try {
          const [name] = resolverIface.decodeFunctionResult('name', r.returnData);
          return name ? { a, name } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!claimed.length) continue;
    const forward = await multicall(claimed.map(({ name }) => resolverIface.encodeFunctionData('addr', [namehash(name)])));
    claimed.forEach(({ a, name }, i) => {
      const r = forward[i];
      if (!r.success || r.returnData === '0x') return;
      try {
        const [addr] = resolverIface.decodeFunctionResult('addr', r.returnData);
        if (addr.toLowerCase() === a) out[a] = name;
      } catch {
        /* unresolvable — skip */
      }
    });
  }
  return out;
}

/** ENS primary names; ReverseRecords already forward-verifies and returns '' otherwise. */
async function ensNames(addresses) {
  const rr = new Contract(ENS_REVERSE_RECORDS, ['function getNames(address[]) view returns (string[])'], getProviders().eth);
  const out = {};
  for (const part of chunks(addresses, CHUNK)) {
    const names = await rr.getNames(part.map((a) => getAddress(a)));
    part.forEach((a, i) => {
      if (names[i]) out[a] = names[i];
    });
  }
  return out;
}

/** Swappable in tests (no network). */
const lookups = { basenames, ensNames };

/** Plain-text names only: no control characters, sane length. */
const cleanName = (n) => (typeof n === 'string' && n.length <= 100 && /^[^\s\u0000-\u001f\u007f]+$/u.test(n) ? n : '');

/**
 * @param {string[]} input  addresses (any case; invalid ones ignored)
 * @returns {Promise<{ ok: true, names: Record<string, string> }>}  lowercase address → name ('' = none)
 */
async function resolveNames(input) {
  const addresses = [...new Set((Array.isArray(input) ? input : []).map((a) => String(a).toLowerCase()))]
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
    .slice(0, MAX_BATCH);
  const names = {};
  if (!addresses.length) return { ok: true, names };

  const cached = await store.getNames(addresses);
  const t = now();
  for (const row of cached) {
    if (row.expires > t) names[row.address] = row.name;
  }
  const missing = addresses.filter((a) => !(a in names));
  if (missing.length) {
    // Either lookup failing just leaves those addresses unnamed (and uncached) this time.
    const [base, ens] = await Promise.all([
      lookups.basenames(missing).catch(() => null),
      lookups.ensNames(missing).catch(() => null),
    ]);
    const rows = [];
    for (const a of missing) {
      const name = cleanName(base?.[a]) || cleanName(ens?.[a]);
      names[a] = name;
      if (base && ens) rows.push({ address: a, name, expires: t + (name ? TTL_NAME : TTL_NONE) });
      else if (name) rows.push({ address: a, name, expires: t + TTL_NAME });
    }
    if (rows.length) await store.setNames(rows);
  }
  return { ok: true, names };
}

module.exports = { resolveNames, MAX_BATCH, _lookups: lookups };
