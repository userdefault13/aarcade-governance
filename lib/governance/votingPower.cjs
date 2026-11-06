/**
 * Voting power at a block — port of the four Snapshot strategies used by aavegotchi.eth.
 *
 * Ported from snapshot-labs/score-api `src/strategies/strategies/*` (MIT, © Snapshot Labs):
 *   erc20-balance-of, aavegotchi-agip, aavegotchi-agip-17, aavegotchi-agip-37-gltr-staked-lp
 * The maths is kept identical so totals match Snapshot.
 * Deliberate differences: a wearable id missing from the price table counts 0 (upstream
 * yields NaN), and a missing staking pool entry counts 0 (upstream throws).
 *
 *   const { getVotingPower } = require('./governance/votingPower.cjs');
 *   const { block, scores } = await getVotingPower(['0xabc…']);
 *   // scores['0xabc…'] = { total, byStrategy: [ghst, wearables, realm, stakedLp] }
 */
const { JsonRpcProvider, Contract, Interface, formatUnits } = require('ethers');
const { baseRpcCandidates, BASE_CHAIN_ID } = require('../baseRpc.cjs');
const { resolveSubgraphUpstream, subgraphProxyHeaders } = require('../subgraphUpstream.cjs');
const SPACE = require('./space.config.cjs');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL_CHUNK = 250;
const SUBGRAPH_ADDR_CHUNK = 100; // owners per `_in` filter
const SUBGRAPH_PAGE_SIZE = 1000;

const multicallIface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
]);
const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);
const itemsIface = new Interface([
  'function itemBalances(address _account) view returns ((uint256 itemId, uint256 balance)[])',
]);
const gotchiIface = new Interface([
  'function tokenIdsOfOwner(address _owner) view returns (uint32[])',
  'function ownerOf(uint256 _tokenId) view returns (address)',
  'function isAavegotchiLent(uint32 _erc721TokenId) view returns (bool)',
  'function getNumericTraits(uint256 _tokenId) view returns (int16[6])',
  'function baseRarityScore(int16[6] _numericTraits) pure returns (uint256)',
  'function equippedWearables(uint256 _tokenId) view returns (uint16[16])',
]);
/** Returns a GotchiLending struct; decoded by word offset (see lendingOriginalOwner). */
const lendingIface = new Interface(['function getGotchiLendingFromToken(uint32 _erc721TokenId) view returns (bytes)']);
const gltrIface = new Interface([
  'function allUserInfo(address _user) view returns ((address lpToken, uint256 allocPoint, uint256 pending, uint256 userBalance, uint256 poolBalance)[] _info)',
]);

/* ------------------------------------------------------------------ transport */

function rpcCandidates() {
  const pinned = String(process.env.GOVERNANCE_RPC_URL || '').trim();
  return [...new Set([pinned, ...baseRpcCandidates()].filter(Boolean))];
}

/**
 * Historical reads need an archive node, so on ANY error (not just rate limits) try the
 * next RPC. Public endpoints commonly reject old blocks with "missing trie node".
 */
async function withArchiveRpc(fn) {
  let lastErr;
  for (const url of rpcCandidates()) {
    try {
      const provider = new JsonRpcProvider(url, { chainId: BASE_CHAIN_ID, name: 'base' }, { staticNetwork: true });
      return await fn(provider);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`No Base RPC could serve the request: ${lastErr?.shortMessage || lastErr?.message || lastErr}`);
}

/**
 * calls: [{ target, iface, fn, args, raw?, allowFailure? }] → decoded results
 * (raw: undecoded returnData). A reverting call throws, like upstream, unless it set
 * allowFailure — then its result is null.
 */
async function multicall(calls, blockTag) {
  const out = [];
  await withArchiveRpc(async (provider) => {
    const mc = new Contract(MULTICALL3, multicallIface, provider);
    out.length = 0;
    for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
      const chunk = calls.slice(i, i + MULTICALL_CHUNK);
      const res = await mc.aggregate3(
        chunk.map((c) => ({ target: c.target, allowFailure: Boolean(c.allowFailure), callData: c.iface.encodeFunctionData(c.fn, c.args) })),
        { blockTag },
      );
      res.forEach((r, j) => {
        if (!r.success) return out.push(null);
        out.push(chunk[j].raw ? r.returnData : chunk[j].iface.decodeFunctionResult(chunk[j].fn, r.returnData)[0]);
      });
    }
  });
  return out;
}

async function subgraphQuery(query, space = SPACE) {
  const res = await fetch(resolveSubgraphUpstream(space.subgraphName), {
    method: 'POST',
    headers: subgraphProxyHeaders(),
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.errors) {
    throw new Error(`Subgraph error (${res.status}): ${JSON.stringify(body?.errors || body).slice(0, 300)}`);
  }
  return body.data;
}

/**
 * Rows of a top-level entity grouped by owner, e.g.
 *   parcels(where: { owner_in: [...] }) { id owner { id } size }
 *
 * The AarcadeGh$t Envio compat proxy supports neither upstream's nested
 * `users { gotchisOriginalOwned / parcelsOwned }` shape nor aliases / multiple root
 * fields, so this pages one `<owner>_in` query per address chunk. Rows are grouped by
 * the owner each row reports (never by which query returned it), so a filter the proxy
 * ignores costs speed, not correctness. Deduped by id in case paging overlaps.
 *
 * Upstream caps each user at 6 × 1000 rows; this counts every row (no holder is near that).
 */
async function entitiesByOwner(addresses, block, entity, ownerField, selection) {
  const byUser = new Map(addresses.map((a) => [a, []]));
  const seen = new Set();
  // Only send `block:` when the subgraph supports time travel; otherwise read head state
  // (getVotingPower reports which block that was).
  const blockArg = SPACE.subgraphTimeTravel && typeof block === 'number' ? `, block: { number: ${block} }` : '';
  for (let i = 0; i < addresses.length; i += SUBGRAPH_ADDR_CHUNK) {
    const ids = addresses.slice(i, i + SUBGRAPH_ADDR_CHUNK);
    for (let skip = 0; ; skip += SUBGRAPH_PAGE_SIZE) {
      const data = await subgraphQuery(
        `{ ${entity}(first: ${SUBGRAPH_PAGE_SIZE}, skip: ${skip}, orderBy: id, orderDirection: asc, ` +
          `where: { ${ownerField}_in: ${JSON.stringify(ids)} }${blockArg}) { id ${ownerField} { id } ${selection} } }`,
      );
      const rows = data[entity] || [];
      for (const row of rows) {
        const owner = String(row[ownerField]?.id ?? row[ownerField] ?? '').toLowerCase();
        if (!byUser.has(owner) || seen.has(row.id)) continue;
        seen.add(row.id);
        byUser.get(owner).push(row);
      }
      if (rows.length < SUBGRAPH_PAGE_SIZE) break;
    }
  }
  return byUser;
}

/* ------------------------------------------------------------------ strategies */
// Each returns Map<lowercaseAddress, number>.

async function erc20BalanceOf(addresses, params, block) {
  const res = await multicall(
    addresses.map((a) => ({ target: params.address, iface: erc20Iface, fn: 'balanceOf', args: [a] })),
    block,
  );
  return new Map(addresses.map((a, i) => [a, parseFloat(formatUnits(res[i], params.decimals))]));
}

/**
 * GotchiLending is returned as a single dynamic tuple: word 0 is the offset, then the
 * fields in order (lender, initialCost, borrower, listingId, erc721TokenId, whitelistId,
 * originalOwner, …). Read by position so the full struct ABI isn't needed; erc721TokenId
 * is checked so a layout change fails loudly instead of misattributing VP.
 */
function lendingOriginalOwner(returnData, tokenId) {
  const hex = returnData.slice(2);
  const base = parseInt(hex.slice(0, 64), 16) * 2;
  const word = (i) => hex.slice(base + i * 64, base + (i + 1) * 64);
  if (BigInt(`0x${word(4)}`) !== BigInt(tokenId)) {
    throw new Error(`GotchiLending layout mismatch for gotchi ${tokenId}`);
  }
  return `0x${word(6).slice(24)}`.toLowerCase();
}

/**
 * Which gotchis count for each voter, decided on-chain at `block`:
 *   not lent → current ERC721 owner;  lent → the lending's originalOwner (the lender).
 * That is upstream's `gotchisOriginalOwned` rule. Candidates come from on-chain
 * tokenIdsOfOwner plus the Envio subgraph (owner / originalOwner), but every candidate is
 * re-verified on-chain, so a stale indexer field can only cost a lookup, never VP.
 */
async function gotchisCountedFor(addresses, params, block) {
  const D = params.tokenAddress;
  const owned = await multicall(
    addresses.map((a) => ({ target: D, iface: gotchiIface, fn: 'tokenIdsOfOwner', args: [a] })),
    block,
  );
  const candidates = new Set(owned.flatMap((ids) => ids.map((id) => Number(id))));
  if (params.gotchiCandidateFields?.length) {
    for (const field of params.gotchiCandidateFields) {
      const rows = await entitiesByOwner(addresses, block, 'aavegotchis', field, '');
      for (const list of rows.values()) for (const r of list) candidates.add(Number(r.id));
    }
  }
  // Subgraph candidates can be burned (sacrificed) or not-yet-existing at `block`; ownerOf
  // reverts for those, and a gotchi with no owner counts for no one — drop it.
  const all = [...candidates];
  const ownerOf = await multicall(
    all.map((id) => ({ target: D, iface: gotchiIface, fn: 'ownerOf', args: [id], allowFailure: true })),
    block,
  );
  const ids = all.filter((_, i) => ownerOf[i] != null);
  const owners = ownerOf.filter((o) => o != null);
  const lent = await multicall(
    ids.map((id) => ({ target: D, iface: gotchiIface, fn: 'isAavegotchiLent', args: [id] })),
    block,
  );
  const lentIds = ids.filter((_, i) => lent[i]);
  const lendings = await multicall(
    lentIds.map((id) => ({ target: D, iface: lendingIface, fn: 'getGotchiLendingFromToken', args: [id], raw: true })),
    block,
  );
  const lender = new Map(lentIds.map((id, i) => [id, lendingOriginalOwner(lendings[i], id)]));

  const wanted = new Set(addresses);
  const byUser = new Map(addresses.map((a) => [a, []]));
  ids.forEach((id, i) => {
    const counted = lent[i] ? lender.get(id) : String(owners[i]).toLowerCase();
    if (wanted.has(counted)) byUser.get(counted).push(id);
  });
  return byUser;
}

/** AGIP: wearable item value held + (BRS + equipped wearable value) of gotchis originally owned. */
async function aavegotchiAgip(addresses, params, block) {
  const D = params.tokenAddress;
  const price = (id) => params.prices[String(Number(id))] ?? 0;
  const [items, byUser] = await Promise.all([
    multicall(addresses.map((a) => ({ target: D, iface: itemsIface, fn: 'itemBalances', args: [a] })), block),
    gotchisCountedFor(addresses, params, block),
  ]);

  const ids = [...new Set([...byUser.values()].flat())];
  const [traits, equipped] = await Promise.all([
    multicall(ids.map((id) => ({ target: D, iface: gotchiIface, fn: 'getNumericTraits', args: [id] })), block),
    multicall(ids.map((id) => ({ target: D, iface: gotchiIface, fn: 'equippedWearables', args: [id] })), block),
  ]);
  // Portals (no traits yet) have BRS 0 upstream; the pure baseRarityScore() of all-zero
  // traits is not 0, so skip them explicitly.
  const isGotchi = traits.map((t) => t.some((v) => Number(v) !== 0));
  const brsIdx = ids.map((_, i) => i).filter((i) => isGotchi[i]);
  const brs = await multicall(
    brsIdx.map((i) => ({ target: D, iface: gotchiIface, fn: 'baseRarityScore', args: [[...traits[i]]] })),
    block,
  );
  const value = new Map(ids.map((id) => [id, 0]));
  brsIdx.forEach((i, k) => {
    const wearables = [...equipped[i]].reduce((s, w) => s + price(w), 0);
    value.set(ids[i], Number(brs[k]) + wearables);
  });

  return new Map(
    addresses.map((a, i) => {
      const itemValue = (items[i] || []).reduce((t, it) => t + price(it.itemId) * Number(it.balance), 0);
      const gotchiValue = byUser.get(a).reduce((t, id) => t + value.get(id), 0);
      return [a, itemValue + gotchiValue];
    }),
  );
}

/** AGIP 17: REALM parcels owned, VP by parcel size. */
async function aavegotchiAgip17(addresses, params, block) {
  const parcels = await entitiesByOwner(addresses, block, 'parcels', params.parcelOwnerField, 'size');
  return new Map(
    addresses.map((a) => [a, (parcels.get(a) || []).reduce((t, p) => t + (params.sizeVp[Number(p.size)] || 0), 0)]),
  );
}

/**
 * AGIP 17 for EVERY parcel owner at the subgraph head — used to freeze REALM VP when a
 * proposal is created (the subgraph cannot be queried at a past block later).
 * @returns {Promise<Record<string, number>>}
 */
async function aavegotchiAgip17AllOwners(params) {
  const out = {};
  const seen = new Set();
  for (let skip = 0; ; skip += SUBGRAPH_PAGE_SIZE) {
    const data = await subgraphQuery(
      `{ parcels(first: ${SUBGRAPH_PAGE_SIZE}, skip: ${skip}, orderBy: id, orderDirection: asc) { id ${params.parcelOwnerField} { id } size } }`,
    );
    const rows = data.parcels || [];
    for (const p of rows) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const owner = String(p[params.parcelOwnerField]?.id ?? p[params.parcelOwnerField] ?? '').toLowerCase();
      if (!owner) continue;
      out[owner] = (out[owner] || 0) + (params.sizeVp[Number(p.size)] || 0);
    }
    if (rows.length < SUBGRAPH_PAGE_SIZE) break;
  }
  return out;
}

/** AGIP 37: GHST side of LP tokens staked in GLTR farming. */
async function aavegotchiAgip37GltrStakedLp(addresses, params, block) {
  const poolCalls = params.pools.flatMap(([lp]) => [
    { target: lp, iface: erc20Iface, fn: 'totalSupply', args: [] },
    { target: params.ghstAddress, iface: erc20Iface, fn: 'balanceOf', args: [lp] },
  ]);
  const userCalls = addresses.map((a) => ({ target: params.gltrStakingAddress, iface: gltrIface, fn: 'allUserInfo', args: [a] }));
  const res = await multicall([...poolCalls, ...userCalls], block);

  const ghstPerLp = params.pools.map((_, k) => Number(res[2 * k + 1]) / 1e18 / (Number(res[2 * k]) / 1e18));
  const base = poolCalls.length;
  return new Map(
    addresses.map((a, i) => {
      const info = res[base + i] || [];
      const vp = params.pools.reduce((t, [, poolId], k) => {
        const staked = info[poolId] ? Number(info[poolId].userBalance) / 1e18 : 0;
        return t + staked * ghstPerLp[k];
      }, 0);
      return [a, vp];
    }),
  );
}

const STRATEGIES = {
  'erc20-balance-of': erc20BalanceOf,
  'aavegotchi-agip': aavegotchiAgip,
  'aavegotchi-agip-17': aavegotchiAgip17,
  'aavegotchi-agip-37-gltr-staked-lp': aavegotchiAgip37GltrStakedLp,
};

/* ------------------------------------------------------------------ public */

/**
 * Block the subgraph is indexed to. Tries Graph-style `_meta`, then Envio's Hasura
 * `chain_metadata` (the compat proxy may pass either through).
 */
async function subgraphHeadBlock(space = SPACE) {
  const errors = [];
  try {
    const d = await subgraphQuery('{ _meta { block { number } } }', space);
    const n = Number(d?._meta?.block?.number);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (e) {
    errors.push(e.message);
  }
  try {
    const d = await subgraphQuery('{ chain_metadata { chain_id latest_processed_block } }', space);
    const row = (d?.chain_metadata || []).find((r) => Number(r.chain_id) === Number(space.chainId));
    const n = Number(row?.latest_processed_block);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (e) {
    errors.push(e.message);
  }
  throw new Error(`Could not read subgraph head block: ${errors.join(' | ').slice(0, 300)}`);
}

/** Strategies that read the subgraph (and so cannot score a past block without time travel). */
function subgraphStrategies(space = SPACE) {
  return space.strategies.filter((s) => s.source === 'subgraph');
}

const ALL_OWNERS = { 'aavegotchi-agip-17': aavegotchiAgip17AllOwners };

/**
 * Freeze subgraph-sourced VP for a new proposal: every holder's score at the subgraph
 * head, and that head block becomes the proposal's snapshot block.
 * @returns {Promise<{ block: number, frozen: Record<string, Record<string, number>> }>}
 */
async function freezeSubgraphStrategies(space = SPACE) {
  const block = await subgraphHeadBlock(space);
  const frozen = {};
  for (const s of subgraphStrategies(space)) {
    const fn = ALL_OWNERS[s.name];
    if (!fn) throw new Error(`No all-owners scan for subgraph strategy ${s.name}`);
    frozen[s.name] = await fn(s.params);
  }
  // The head may have moved during the scan; re-read so the gap is visible to callers.
  const after = await subgraphHeadBlock(space);
  return { block, blockAfter: after, frozen };
}

/**
 * Voting power for addresses.
 *
 *  - `frozen` (from freezeSubgraphStrategies, stored on the proposal) supplies the
 *    subgraph-sourced strategies; on-chain strategies are read at `block`. This is how a
 *    proposal's votes are scored, at any later time.
 *  - Without `frozen` and without subgraph time travel, everything is read at the
 *    subgraph head (`block` must be omitted or equal it) — used for "your VP now".
 *
 * @param {string[]} addresses
 * @param {{ block?: number, frozen?: Record<string, Record<string, number>>, space?: typeof SPACE }} [opts]
 * @returns {Promise<{ block: number, scores: Record<string, { total: number, byStrategy: number[] }> }>}
 */
async function getVotingPower(addresses, opts = {}) {
  const space = opts.space || SPACE;
  const frozen = opts.frozen || null;
  let block = typeof opts.block === 'number' ? opts.block : null;
  const lower = [...new Set(addresses.map((a) => String(a).toLowerCase()))];

  const needsLiveSubgraph = subgraphStrategies(space).some((s) => !frozen?.[s.name]);
  if (needsLiveSubgraph && !space.subgraphTimeTravel) {
    const head = await subgraphHeadBlock(space);
    if (block != null && block !== head) {
      throw new Error(
        `Subgraph cannot time-travel: asked for block ${block}, indexer is at ${head}. Pass the proposal's frozen VP.`,
      );
    }
    block = head;
  }
  if (block == null) throw new Error('block is required');
  if (!lower.length) return { block, scores: {} };

  // Any strategy failing fails the whole call — never silently score someone 0.
  const perStrategy = await Promise.all(
    space.strategies.map((s) => {
      if (frozen?.[s.name]) {
        const table = frozen[s.name];
        return new Map(lower.map((a) => [a, Number(table[a] || 0)]));
      }
      const fn = STRATEGIES[s.name];
      if (!fn) throw new Error(`Unknown strategy ${s.name}`);
      return fn(lower, s.params, block);
    }),
  );

  const scores = Object.fromEntries(
    addresses.map((addr) => {
      const a = String(addr).toLowerCase();
      const byStrategy = perStrategy.map((m) => m.get(a) || 0);
      return [addr, { total: byStrategy.reduce((x, y) => x + y, 0), byStrategy }];
    }),
  );
  return { block, scores };
}

module.exports = {
  getVotingPower,
  freezeSubgraphStrategies,
  subgraphHeadBlock,
  strategyLabels: () => SPACE.strategies.map((s) => s.label),
  STRATEGIES,
};
