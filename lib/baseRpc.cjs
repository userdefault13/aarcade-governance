/**
 * Server-side Base RPC URL selection: vault/env RPC first, then public Base endpoints.
 * No Alchemy — any alchemy.com value found in env is ignored.
 */
const { JsonRpcProvider } = require('ethers');

const BASE_CHAIN_ID = 8453;
const RPC_CALL_TIMEOUT_MS = 12_000;

function isRpcRateLimitError(err) {
  const msg = `${err?.message || err || ''} ${err?.info?.error?.message || ''} ${JSON.stringify(err?.info || '')}`;
  return /monthly capacity limit exceeded|rate limit|429|-32016|too many requests/i.test(msg);
}

// eslint-disable-next-line no-unused-vars
function baseRpcCandidates(_opts = {}) {
  const urls = [];
  for (const envKey of [
    'BASE_RPC_URL',
    'SAFE_RPC_URL',
    'JUICEBOX_RPC_BASE',
    'VITE_JUICEBOX_RPC_BASE',
    'VITE_BASE_RPC_URL',
  ]) {
    const v = String(process.env[envKey] || '').trim();
    if (!v) continue;
    if (/alchemy\.com/i.test(v)) continue; // project rule: no Alchemy
    urls.push(v);
  }
  urls.push(
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://mainnet.base.org',
  );
  return [...new Set(urls.filter(Boolean))];
}

async function withRpcTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), RPC_CALL_TIMEOUT_MS);
    }),
  ]);
}

async function getWorkingBaseRpcUrl(_opts = {}) {
  let lastErr;
  for (const rpcUrl of baseRpcCandidates()) {
    try {
      const provider = new JsonRpcProvider(rpcUrl, { chainId: BASE_CHAIN_ID, name: 'base' });
      await withRpcTimeout(provider.getBlockNumber(), `Base RPC (${rpcUrl})`);
      return rpcUrl;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No working Base RPC endpoint');
}

/**
 * Run fn(rpcUrl) against the first candidate; on a rate limit, retry the remaining endpoints.
 */
async function withBaseRpcFallback(fn, _opts = {}) {
  const candidates = baseRpcCandidates();
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await fn(candidates[i]);
    } catch (e) {
      lastErr = e;
      if (!isRpcRateLimitError(e)) throw e;
    }
  }
  throw lastErr || new Error('Base RPC unavailable');
}

function humanizeRpcError(err) {
  const msg = String(err?.message || err || '');
  if (/monthly capacity limit exceeded|429|rate limit|-32016/i.test(msg)) {
    return 'Base RPC rate limit reached. Showing proposals; on-chain claim status may be incomplete — retry shortly.';
  }
  if (/SERVER_ERROR|CLIENT ESCALATED|timed out/i.test(msg)) {
    return 'Temporary Base network error. Please retry in a moment.';
  }
  if (msg.length > 180 || /0x71c3/i.test(msg)) {
    return 'Could not load airdrop data from Base. Please retry.';
  }
  return msg;
}

module.exports = {
  BASE_CHAIN_ID,
  isRpcRateLimitError,
  baseRpcCandidates,
  getWorkingBaseRpcUrl,
  withBaseRpcFallback,
  humanizeRpcError,
};
