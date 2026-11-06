/**
 * Upstream URLs for /api/subgraph/:name (Vercel + Express).
 * Defaults to Aarcade home Envio compat proxy (subgraph.aarcadeghst.com).
 * Override with AAVEGOTCHI_SUBGRAPH_PROXY_URL or per-name AAVEGOTCHI_SUBGRAPH_UPSTREAM_*.
 * When SUBGRAPH_PROXY_SECRET is set, callers must forward X-Subgraph-Proxy-Key.
 */
const AARCADE_SUBGRAPH_PROXY_BASE = (
  process.env.AAVEGOTCHI_SUBGRAPH_PROXY_URL ||
  'https://subgraph.aarcadeghst.com/subgraphs/name'
).replace(/\/$/, '');

function aarcadeSubgraphUrl(name) {
  return `${AARCADE_SUBGRAPH_PROXY_BASE}/${name}`;
}

function resolveSubgraphUpstream(name) {
  const override = process.env[`AAVEGOTCHI_SUBGRAPH_UPSTREAM_${String(name).toUpperCase().replace(/-/g, '_')}`];
  if (override && String(override).trim()) {
    return String(override).trim().replace(/\/$/, '');
  }
  return aarcadeSubgraphUrl(name);
}

/**
 * Headers for server-side POSTs to the Aarcade home Envio tunnel / compat proxy.
 * @param {Record<string, string>} [extra]
 */
function subgraphProxyHeaders(extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
  const secret = String(process.env.SUBGRAPH_PROXY_SECRET || '').trim();
  if (secret) {
    headers['X-Subgraph-Proxy-Key'] = secret;
  }
  return headers;
}

module.exports = {
  AARCADE_SUBGRAPH_PROXY_BASE,
  aarcadeSubgraphUrl,
  resolveSubgraphUpstream,
  subgraphProxyHeaders,
};
