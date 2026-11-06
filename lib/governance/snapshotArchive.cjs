/**
 * Snapshot → Aarcade archive. Copies every aavegotchi.eth proposal and every vote from the
 * Snapshot hub so the history is hosted by Aarcade once live voting moves to self-hosted
 * governance. Archived proposals are read-only: scores are Snapshot's own final scores,
 * never re-tallied, and each vote keeps the IPFS id of its original signed envelope.
 *
 * Re-runnable: everything is an upsert keyed by Snapshot id, and each proposal's votes are
 * checked against Snapshot's own vote count plus a sha-256 digest stored with the proposal.
 */
const crypto = require('node:crypto');
const SPACE = require('./space.config.cjs');

const HUB = String(process.env.SNAPSHOT_HUB_URL || 'https://hub.snapshot.org/graphql').trim();
const PROPOSAL_PAGE = 100;
const VOTE_PAGE = 1000;
/** The public hub rate-limits anonymous clients; stay well under it. */
const MIN_REQUEST_GAP_MS = 700;

const PROPOSAL_FIELDS = `
  id ipfs author created network symbol type title body discussion choices start end
  quorum quorumType privacy snapshot state link app flagged
  scores scores_by_strategy scores_state scores_total scores_updated votes
  strategies { name network params }
  validation { name params }
  plugins
`;
const VOTE_FIELDS = 'id ipfs voter created choice reason vp vp_by_strategy vp_state app metadata';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Order-independent digest of a proposal's votes (sorted by vote id). */
function votesDigest(votes) {
  const sorted = [...votes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return crypto.createHash('sha256').update(canonicalJson(sorted)).digest('hex');
}

/** Snapshot ids: 0x… hashes compare case-insensitively; older IPFS ids (Qm…) are case-sensitive. */
function normId(id) {
  const s = String(id || '').trim();
  return /^0x/i.test(s) ? s.toLowerCase() : s;
}

function normalizeProposal(p) {
  return {
    id: normId(p.id),
    space: SPACE.legacySnapshotSpace,
    ipfs: p.ipfs || null,
    author: String(p.author || '').toLowerCase(),
    created: Number(p.created),
    network: p.network || null,
    symbol: p.symbol || null,
    type: p.type,
    title: p.title || '',
    body: p.body || '',
    discussion: p.discussion || '',
    choices: p.choices || [],
    start: Number(p.start),
    end: Number(p.end),
    quorum: Number(p.quorum) || 0,
    quorumType: p.quorumType || null,
    privacy: p.privacy || '',
    snapshot: p.snapshot ? Number(p.snapshot) : null,
    state: p.state,
    link: p.link || null,
    app: p.app || null,
    flagged: Boolean(p.flagged),
    scores: p.scores || [],
    scoresByStrategy: p.scores_by_strategy || [],
    scoresState: p.scores_state || null,
    scoresTotal: Number(p.scores_total) || 0,
    scoresUpdated: Number(p.scores_updated) || null,
    votes: Number(p.votes) || 0,
    strategies: p.strategies || [],
    validation: p.validation || null,
    plugins: p.plugins || {},
  };
}

function normalizeVote(v, proposalId) {
  return {
    id: normId(v.id),
    proposalId,
    ipfs: v.ipfs || null,
    voter: String(v.voter || '').toLowerCase(),
    created: Number(v.created),
    choice: v.choice,
    reason: v.reason || '',
    vp: Number(v.vp) || 0,
    vpByStrategy: v.vp_by_strategy || [],
    vpState: v.vp_state || null,
    app: v.app || null,
    metadata: v.metadata || {},
  };
}

function createHubClient({ hub = HUB, fetchImpl = fetch, gapMs = MIN_REQUEST_GAP_MS, retries = 5 } = {}) {
  let last = 0;
  return async function query(q, variables) {
    for (let attempt = 0; ; attempt++) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      let res;
      try {
        res = await fetchImpl(hub, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, variables }),
        });
      } catch (e) {
        if (attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retries) throw new Error(`Snapshot hub HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      const json = await res.json();
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
      return json.data;
    }
  };
}

/** Space header info (name, about, counts) as it stands at archive time. */
async function fetchSpaceMeta(query, space = SPACE.legacySnapshotSpace) {
  const data = await query(
    `query S($id: String!) { space(id: $id) { id name about network symbol avatar website twitter github proposalsCount votesCount followersCount } }`,
    { id: space },
  );
  return { ...(data?.space || { id: space }), capturedAt: Math.floor(Date.now() / 1000) };
}

async function fetchAllProposals(query, space = SPACE.legacySnapshotSpace) {
  const out = [];
  for (let skip = 0; ; skip += PROPOSAL_PAGE) {
    const data = await query(
      `query P($space: String!, $first: Int!, $skip: Int!) {
        proposals(first: $first, skip: $skip, where: { space: $space }, orderBy: "created", orderDirection: asc) { ${PROPOSAL_FIELDS} }
      }`,
      { space, first: PROPOSAL_PAGE, skip },
    );
    const page = data?.proposals || [];
    out.push(...page);
    if (page.length < PROPOSAL_PAGE) return out;
  }
}

/**
 * Every vote on one proposal. Pages by `created` (the hub caps `skip` at 5,000), and within
 * a timestamp shared across a page boundary by `skip`, so no vote is missed or doubled.
 */
async function fetchProposalVotes(query, proposalId) {
  const byId = new Map();
  let since = 0;
  let skip = 0;
  for (;;) {
    const data = await query(
      `query V($proposal: String!, $first: Int!, $skip: Int!, $since: Int!) {
        votes(first: $first, skip: $skip, where: { proposal: $proposal, created_gte: $since }, orderBy: "created", orderDirection: asc) { ${VOTE_FIELDS} }
      }`,
      { proposal: proposalId, first: VOTE_PAGE, skip, since },
    );
    const page = data?.votes || [];
    for (const v of page) byId.set(normId(v.id), v);
    if (page.length < VOTE_PAGE) break;
    const last = Number(page[page.length - 1].created);
    if (last === since) {
      skip += page.length; // the whole page sat on `since`
    } else {
      since = last;
      skip = page.filter((v) => Number(v.created) === last).length;
    }
  }
  return [...byId.values()];
}

/**
 * Archive the space. `sink` receives each finished proposal:
 *   await sink({ proposal, votes })   proposal carries votesDigest + archivedVotes
 * @param {{ query?: Function, only?: string[], skip?: (p) => boolean, log?: Function }} opts
 *   skip(proposal) lets a re-run skip proposals already archived and unchanged.
 */
async function archiveSpace(sink, { query = createHubClient(), only, skip, log = () => {} } = {}) {
  const raw = await fetchAllProposals(query);
  const wanted = only?.length ? raw.filter((p) => only.includes(normId(p.id))) : raw;
  const stats = { proposals: 0, skipped: 0, votes: 0, mismatches: [], live: [] };
  for (const [i, p] of wanted.entries()) {
    const proposal = normalizeProposal(p);
    if (proposal.state !== 'closed') stats.live.push(proposal.id);
    if (skip?.(proposal)) {
      stats.skipped++;
      continue;
    }
    const votes = (await fetchProposalVotes(query, p.id)).map((v) => normalizeVote(v, proposal.id));
    if (votes.length !== proposal.votes) stats.mismatches.push({ id: proposal.id, expected: proposal.votes, got: votes.length });
    proposal.archivedVotes = votes.length;
    proposal.votesDigest = votesDigest(votes);
    proposal.archivedAt = Math.floor(Date.now() / 1000);
    await sink({ proposal, votes });
    stats.proposals++;
    stats.votes += votes.length;
    log(`[${i + 1}/${wanted.length}] ${proposal.id.slice(0, 10)} ${votes.length} votes — ${proposal.title.slice(0, 60)}`);
  }
  return stats;
}

module.exports = {
  HUB,
  normId,
  canonicalJson,
  votesDigest,
  normalizeProposal,
  normalizeVote,
  createHubClient,
  fetchSpaceMeta,
  fetchAllProposals,
  fetchProposalVotes,
  archiveSpace,
};
