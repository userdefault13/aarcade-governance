/**
 * Snapshot-hub-compatible GraphQL, answered by Aarcade instead of hub.snapshot.org.
 *
 * Server code written against the Snapshot hub (XP drops, airdrop checks, quorum voter
 * index, proposal polling, profile activity) keeps its queries and calls query() here:
 *   proposals / proposal / votes / vote / space
 * Data: the archived aavegotchi.eth history (snapshotArchive.cjs) plus live self-hosted
 * proposals and votes, which appear under the same space so history continues unbroken.
 * Cancelled live proposals are left out; sealed (blind) choices stay null until revealed.
 *
 * SNAPSHOT_SOURCE=hub sends queries to the real hub instead (fallback only).
 */
const { buildSchema, graphql } = require('graphql');
const SPACE = require('./space.config.cjs');
const store = require('./store.cjs');
const { splitLinks } = require('./links.cjs');

const LEGACY_SPACE = SPACE.legacySnapshotSpace;
const HUB = String(process.env.SNAPSHOT_HUB_URL || 'https://hub.snapshot.org/graphql').trim();
const PROPOSAL_CACHE_MS = 60_000;
const MAX_FIRST = 1000;

const schema = buildSchema(`
  scalar Any

  enum OrderDirection { asc desc }

  type Space {
    id: String
    name: String
    about: String
    network: String
    symbol: String
    avatar: String
    website: String
    twitter: String
    github: String
    proposalsCount: Int
    votesCount: Int
    followersCount: Int
  }

  type Strategy { name: String network: String params: Any }
  type Validation { name: String params: Any }

  type Proposal {
    id: String!
    ipfs: String
    author: String
    created: Int
    network: String
    symbol: String
    type: String
    title: String
    body: String
    discussion: String
    choices: [String]
    start: Int
    end: Int
    quorum: Float
    quorumType: String
    privacy: String
    snapshot: String
    state: String
    link: String
    app: String
    flagged: Boolean
    scores: [Float]
    scores_by_strategy: Any
    scores_state: String
    scores_total: Float
    scores_updated: Int
    votes: Int
    strategies: [Strategy]
    validation: Validation
    plugins: Any
    space: Space
  }

  type Vote {
    id: String!
    ipfs: String
    voter: String!
    created: Int!
    choice: Any
    reason: String
    vp: Float
    vp_by_strategy: [Float]
    vp_state: String
    app: String
    metadata: Any
    proposal: Proposal
    space: Space
  }

  input ProposalWhere {
    id: String
    id_in: [String]
    space: String
    space_in: [String]
    state: String
    author: String
    author_in: [String]
    created_gt: Int
    created_gte: Int
    created_lt: Int
    created_lte: Int
    start_gt: Int
    start_gte: Int
    start_lt: Int
    start_lte: Int
    end_gt: Int
    end_gte: Int
    end_lt: Int
    end_lte: Int
    title_contains: String
  }

  input VoteWhere {
    id: String
    id_in: [String]
    space: String
    space_in: [String]
    voter: String
    voter_in: [String]
    proposal: String
    proposal_in: [String]
    created_gt: Int
    created_gte: Int
    created_lt: Int
    created_lte: Int
  }

  type Query {
    proposals(first: Int, skip: Int, where: ProposalWhere, orderBy: String, orderDirection: OrderDirection): [Proposal]
    proposal(id: String!): Proposal
    votes(first: Int, skip: Int, where: VoteWhere, orderBy: String, orderDirection: OrderDirection): [Vote]
    vote(id: String!): Vote
    space(id: String!): Space
  }
`);

/** 0x… ids compare case-insensitively; legacy IPFS ids (Qm…) are case-sensitive. */
const normId = (id) => (/^0x/i.test(String(id || '')) ? String(id).toLowerCase() : String(id || ''));
const lower = (v) => String(v || '').toLowerCase();

/* ------------------------------------------------------------------ proposals */

function archivedToSnapshot(p) {
  return {
    ...p,
    snapshot: p.snapshot != null ? String(p.snapshot) : null,
    scores_by_strategy: p.scoresByStrategy,
    scores_state: p.scoresState,
    scores_total: p.scoresTotal,
    scores_updated: p.scoresUpdated,
    spaceId: LEGACY_SPACE,
  };
}

/** Live self-hosted proposal in Snapshot's shape. Scores come from the live tally. */
function liveToSnapshot(p, results, state) {
  return {
    id: p.id,
    ipfs: p.groveUri || null,
    author: p.author,
    created: p.created,
    network: String(SPACE.chainId),
    symbol: 'VP',
    type: p.type,
    title: p.title,
    body: p.body,
    // Snapshot clients expect one URL: hand them the first link.
    discussion: splitLinks(p.discussion)[0] || '',
    choices: p.choices,
    start: p.start,
    end: p.end,
    quorum: p.quorum,
    quorumType: 'default',
    privacy: p.privacy === 'shielded' ? 'shutter' : '',
    snapshot: p.snapshot != null ? String(p.snapshot) : null,
    state,
    link: null,
    app: 'aarcade-gh-t',
    flagged: false,
    scores: Array.isArray(results?.scores) ? results.scores : [],
    scores_by_strategy: null,
    scores_state: state === 'closed' ? 'final' : 'pending',
    scores_total: results?.scoresTotal ?? 0,
    scores_updated: null,
    votes: results?.votes ?? 0,
    strategies: p.strategies,
    validation: null,
    plugins: {},
    spaceId: LEGACY_SPACE,
  };
}

let proposalCache = null;

/** Every proposal (archive + live, cancelled live ones dropped), cached briefly. */
async function allProposals() {
  if (proposalCache && Date.now() - proposalCache.at < PROPOSAL_CACHE_MS) return proposalCache.rows;
  // Lazy: service.cjs pulls in voting power / Grove, which only live tallies need.
  const service = require('./service.cjs');
  const [archived, live] = await Promise.all([
    (await store.collection('governance_archive_proposals')).find({}, { projection: { _id: 0 } }).toArray(),
    (await store.collection('governance_proposals')).find({}, { projection: { _id: 0 } }).toArray(),
  ]);
  const liveRows = await Promise.all(
    live
      .filter((p) => !p.cancelled)
      .map(async (p) => {
        const full = await service.getResults(p.id);
        return liveToSnapshot(p, full.ok ? full.results : null, service.proposalState(p));
      }),
  );
  const rows = [...archived.map(archivedToSnapshot), ...liveRows];
  proposalCache = { at: Date.now(), rows };
  return rows;
}

const RANGE = { _gt: (a, b) => a > b, _gte: (a, b) => a >= b, _lt: (a, b) => a < b, _lte: (a, b) => a <= b };

function proposalMatches(p, where = {}) {
  if (where.id && normId(p.id) !== normId(where.id)) return false;
  if (where.id_in && !where.id_in.map(normId).includes(normId(p.id))) return false;
  if (where.space && where.space !== p.spaceId) return false;
  if (where.space_in && !where.space_in.includes(p.spaceId)) return false;
  if (where.state && where.state !== 'all' && where.state !== p.state) return false;
  if (where.author && lower(where.author) !== lower(p.author)) return false;
  if (where.author_in && !where.author_in.map(lower).includes(lower(p.author))) return false;
  if (where.title_contains && !String(p.title).toLowerCase().includes(String(where.title_contains).toLowerCase())) return false;
  for (const field of ['created', 'start', 'end']) {
    for (const [suffix, cmp] of Object.entries(RANGE)) {
      const bound = where[`${field}${suffix}`];
      if (bound != null && !cmp(p[field], bound)) return false;
    }
  }
  return true;
}

function sortAndPage(rows, { orderBy = 'created', orderDirection = 'desc', first = 20, skip = 0 } = {}) {
  const dir = String(orderDirection).toLowerCase() === 'asc' ? 1 : -1;
  const key = orderBy || 'created';
  return [...rows]
    .sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * dir)
    .slice(skip || 0, (skip || 0) + Math.min(first ?? 20, MAX_FIRST));
}

async function findProposal(id) {
  const want = normId(id);
  return (await allProposals()).find((p) => normId(p.id) === want) || null;
}

/* ---------------------------------------------------------------------- votes */

/** Mongo filter for one vote source. Field names differ: archive uses `created`, live `timestamp`. */
function voteFilter(where = {}, { createdField }) {
  const f = {};
  const ids = where.proposal ? [where.proposal] : where.proposal_in;
  if (ids) f.proposalId = { $in: ids.map(normId) };
  const voters = where.voter ? [where.voter] : where.voter_in;
  if (voters) f.voter = { $in: voters.map(lower) };
  const range = {};
  for (const [suffix, op] of [['_gt', '$gt'], ['_gte', '$gte'], ['_lt', '$lt'], ['_lte', '$lte']]) {
    if (where[`created${suffix}`] != null) range[op] = where[`created${suffix}`];
  }
  if (Object.keys(range).length) f[createdField] = range;
  return f;
}

function liveVoteToSnapshot(v) {
  return {
    id: `${v.proposalId}:${v.voter}`,
    ipfs: v.groveUri || null,
    voter: v.voter,
    created: v.timestamp,
    choice: v.choice ?? null,
    reason: v.reason || '',
    vp: v.vp,
    vp_by_strategy: v.vpByStrategy || [],
    vp_state: 'final',
    app: v.app || null,
    metadata: {},
    proposalId: v.proposalId,
  };
}

function archivedVoteToSnapshot(v) {
  return {
    ...v,
    vp_by_strategy: v.vpByStrategy,
    vp_state: v.vpState,
  };
}

async function findVotes({ first = 20, skip = 0, where = {}, orderBy = 'created', orderDirection = 'desc' } = {}) {
  if (where.space && where.space !== LEGACY_SPACE) return [];
  if (where.space_in && !where.space_in.includes(LEGACY_SPACE)) return [];
  const limit = Math.min(first ?? 20, MAX_FIRST) + (skip || 0);
  const dir = String(orderDirection).toLowerCase() === 'asc' ? 1 : -1;
  const key = orderBy === 'vp' ? 'vp' : 'created';

  const idFilter = where.id ? [where.id] : where.id_in;
  const archivedQuery = voteFilter(where, { createdField: 'created' });
  if (idFilter) archivedQuery.id = { $in: idFilter.map(normId) };
  const liveQuery = voteFilter(where, { createdField: 'timestamp' });

  const [archived, live] = await Promise.all([
    (await store.collection('governance_archive_votes'))
      .find(archivedQuery, { projection: { _id: 0 } })
      .sort({ [key]: dir })
      .limit(limit)
      .toArray(),
    // Live vote ids are synthetic (`proposal:voter`), so an id filter only ever hits the archive.
    idFilter
      ? []
      : (await store.collection('governance_votes'))
          .find(liveQuery, { projection: { _id: 0, message: 0, signature: 0 } })
          .sort({ [key === 'created' ? 'timestamp' : 'vp']: dir })
          .limit(limit)
          .toArray(),
  ]);
  const liveIds = new Set((await allProposals()).filter((p) => p.app === 'aarcade-gh-t').map((p) => p.id));
  const merged = [
    ...archived.map(archivedVoteToSnapshot),
    ...live.filter((v) => liveIds.has(v.proposalId)).map(liveVoteToSnapshot),
  ];
  return merged.sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * dir).slice(skip || 0, limit);
}

/* ------------------------------------------------------------------- resolvers */

async function spaceInfo(id) {
  if (id !== LEGACY_SPACE) return null;
  const meta = (await store.getArchiveSpace()) || { id: LEGACY_SPACE, name: SPACE.name };
  const rows = await allProposals();
  const live = rows.filter((p) => p.app === 'aarcade-gh-t');
  return {
    ...meta,
    proposalsCount: (meta.proposalsCount ?? rows.length - live.length) + live.length,
    votesCount: (meta.votesCount ?? 0) + live.reduce((n, p) => n + (p.votes || 0), 0),
  };
}

function withSpace(p) {
  return p && { ...p, space: () => spaceInfo(p.spaceId) };
}

function withProposal(v) {
  return {
    ...v,
    proposal: async () => withSpace(await findProposal(v.proposalId)),
    space: () => spaceInfo(LEGACY_SPACE),
  };
}

const root = {
  proposals: async (args) => sortAndPage((await allProposals()).filter((p) => proposalMatches(p, args.where)), args).map(withSpace),
  proposal: async ({ id }) => withSpace(await findProposal(id)),
  votes: async (args) => (await findVotes(args)).map(withProposal),
  vote: async ({ id }) => {
    const [hit] = await findVotes({ first: 1, where: { id } });
    return hit ? withProposal(hit) : null;
  },
  space: ({ id }) => spaceInfo(id),
};

async function hubQuery(query, variables) {
  const res = await fetch(HUB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Snapshot hub error: ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

/**
 * Run a Snapshot-hub GraphQL query. Returns `data`; throws on GraphQL errors, like the
 * hub helpers it replaces.
 */
async function query(source, variables = {}) {
  if (String(process.env.SNAPSHOT_SOURCE || '').trim() === 'hub') return hubQuery(source, variables);
  const result = await graphql({ schema, source, rootValue: root, variableValues: variables });
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join('; '));
  // graphql-js builds prototype-less objects; hand back plain JSON like the hub did.
  return JSON.parse(JSON.stringify(result.data));
}

/** Drop the proposal cache (tests; after an import). */
function resetCache() {
  proposalCache = null;
}

module.exports = { query, resetCache, LEGACY_SPACE };
