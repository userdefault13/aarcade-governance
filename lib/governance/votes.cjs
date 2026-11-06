/**
 * Signed votes: EIP-712 message format, signature verification, choice validation, tally.
 * Pure apart from the EIP-1271 RPC check — no storage here (see store.cjs).
 *
 * Choice encoding (1-indexed, like Snapshot), carried as a JSON string in the signed message:
 *   weighted       {"1": 60, "2": 40}   share of the voter's VP per choice
 *   ranked-choice  [2, 1, 3]            every choice, most preferred first
 *   poll           2                    one choice; every wallet counts once (not by VP)
 * Shielded proposals carry that JSON tlock-encrypted instead (see shield.cjs).
 */
const { TypedDataEncoder, verifyTypedData, Contract, JsonRpcProvider, keccak256, toUtf8Bytes, getAddress } = require('ethers');
const { baseRpcCandidates, BASE_CHAIN_ID } = require('../baseRpc.cjs');
const SPACE = require('./space.config.cjs');
const shield = require('./shield.cjs');

const VOTE_TYPES = {
  Vote: [
    { name: 'from', type: 'address' },
    { name: 'space', type: 'string' },
    { name: 'proposal', type: 'bytes32' },
    { name: 'choice', type: 'string' },
    { name: 'reason', type: 'string' },
    { name: 'app', type: 'string' },
    { name: 'timestamp', type: 'uint64' },
  ],
};

const MAX_CLOCK_SKEW_SEC = 10 * 60;
const MAX_REASON_LEN = 2000;
const EIP1271_MAGIC = '0x1626ba7e';

/* ------------------------------------------------------------------ ids */

/** Stable JSON (sorted keys) so the same proposal always hashes to the same id. */
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

/** Proposal id = keccak256 of its canonical immutable fields. */
function proposalId(fields) {
  return keccak256(toUtf8Bytes(canonicalJson(fields)));
}

/* ------------------------------------------------------------------ choices */

/**
 * @returns {{ ok: true, choice: object | number[] } | { ok: false, error: string }}
 */
function validateChoice(type, choiceJson, nChoices) {
  let choice;
  try {
    choice = typeof choiceJson === 'string' ? JSON.parse(choiceJson) : choiceJson;
  } catch {
    return { ok: false, error: 'choice is not valid JSON' };
  }
  const inRange = (i) => Number.isInteger(i) && i >= 1 && i <= nChoices;

  if (type === 'weighted') {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      return { ok: false, error: 'weighted choice must be an object like {"1": 60, "2": 40}' };
    }
    const out = {};
    let sum = 0;
    for (const [k, v] of Object.entries(choice)) {
      const i = Number(k);
      if (!inRange(i)) return { ok: false, error: `choice ${k} does not exist` };
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { ok: false, error: 'weights must be numbers ≥ 0' };
      if (v > 0) out[i] = v;
      sum += v;
    }
    if (sum <= 0) return { ok: false, error: 'weighted vote needs at least one weight > 0' };
    return { ok: true, choice: out };
  }

  if (type === 'poll') {
    if (!inRange(choice)) return { ok: false, error: `poll choice must be a number 1–${nChoices}` };
    return { ok: true, choice };
  }

  if (type === 'ranked-choice') {
    if (!Array.isArray(choice)) return { ok: false, error: 'ranked choice must be an array like [2, 1, 3]' };
    const set = new Set(choice);
    if (choice.length !== nChoices || set.size !== nChoices || !choice.every(inRange)) {
      return { ok: false, error: `rank all ${nChoices} choices exactly once` };
    }
    return { ok: true, choice: [...choice] };
  }

  return { ok: false, error: `unsupported voting type ${type}` };
}

/* ------------------------------------------------------------------ signatures */

function rpcProvider() {
  const url = String(process.env.GOVERNANCE_RPC_URL || '').trim() || baseRpcCandidates()[0];
  return new JsonRpcProvider(url, { chainId: BASE_CHAIN_ID, name: 'base' }, { staticNetwork: true });
}

/**
 * EOA signatures via ecrecover; contract wallets (Safe etc.) via EIP-1271 on Base.
 * @returns {Promise<boolean>}
 */
async function verifyVoteSignature(message, signature, space = SPACE) {
  const from = getAddress(message.from);
  try {
    if (getAddress(verifyTypedData(space.eip712Domain, VOTE_TYPES, message, signature)) === from) return true;
  } catch {
    // not a plain ECDSA signature — fall through to EIP-1271
  }
  const provider = rpcProvider();
  if ((await provider.getCode(from)) === '0x') return false;
  const digest = TypedDataEncoder.hash(space.eip712Domain, VOTE_TYPES, message);
  const wallet = new Contract(from, ['function isValidSignature(bytes32, bytes) view returns (bytes4)'], provider);
  try {
    return (await wallet.isValidSignature(digest, signature)).toLowerCase() === EIP1271_MAGIC;
  } catch {
    return false;
  }
}

/**
 * Shape + window checks for a vote against its proposal (no signature / VP here).
 * @returns {{ ok: true, choice: any } | { ok: false, status: number, error: string }}
 */
function checkVote(message, proposal, { now = Math.floor(Date.now() / 1000), space = SPACE } = {}) {
  if (!message || typeof message !== 'object') return { ok: false, status: 400, error: 'message required' };
  for (const f of VOTE_TYPES.Vote) {
    if (message[f.name] === undefined || message[f.name] === null) {
      return { ok: false, status: 400, error: `message.${f.name} required` };
    }
  }
  if (message.space !== space.id) return { ok: false, status: 400, error: `wrong space (expected ${space.id})` };
  if (!proposal) return { ok: false, status: 404, error: 'proposal not found' };
  if (String(message.proposal).toLowerCase() !== proposal.id) return { ok: false, status: 400, error: 'proposal mismatch' };
  if (proposal.cancelled) return { ok: false, status: 409, error: 'proposal was cancelled' };
  if (now < proposal.start) return { ok: false, status: 409, error: 'voting has not started' };
  if (now > proposal.end) return { ok: false, status: 409, error: 'voting has ended' };
  const ts = Number(message.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SEC) {
    return { ok: false, status: 400, error: 'timestamp too far from server time — check your clock and sign again' };
  }
  if (String(message.reason).length > MAX_REASON_LEN) return { ok: false, status: 400, error: 'reason too long' };
  if (proposal.privacy === 'shielded') {
    // A plaintext reason would leak the hidden choice while voting is open.
    if (String(message.reason) !== '') return { ok: false, status: 400, error: 'shielded votes cannot carry a public reason' };
    const ct = shield.checkCiphertext(message.choice, proposal.tlock);
    if (!ct.ok) return { ok: false, status: 400, error: ct.error };
    return { ok: true, choice: null, encrypted: true };
  }
  const c = validateChoice(proposal.type, message.choice, proposal.choices.length);
  if (!c.ok) return { ok: false, status: 400, error: c.error };
  return { ok: true, choice: c.choice };
}

/* ------------------------------------------------------------------ tally */

/**
 * @param {{ type: string, choices: string[], quorum: number }} proposal
 * @param {{ choice: any, vp: number }[]} votes  latest vote per voter only
 */
function tally(proposal, votes) {
  const n = proposal.choices.length;

  if (proposal.type === 'poll') {
    // One wallet, one vote: scores are voter counts; VP is reported but doesn't weigh.
    const scores = new Array(n).fill(0);
    for (const v of votes) scores[v.choice - 1] += 1;
    return { ...pollBase(proposal, votes), scores };
  }

  const total = votes.reduce((t, v) => t + v.vp, 0);
  const base = { scoresTotal: total, votes: votes.length, quorum: proposal.quorum, quorumReached: total >= proposal.quorum };

  if (proposal.type === 'weighted') {
    const scores = new Array(n).fill(0);
    for (const v of votes) {
      const sum = Object.values(v.choice).reduce((a, b) => a + b, 0);
      for (const [k, w] of Object.entries(v.choice)) scores[Number(k) - 1] += (v.vp * w) / sum;
    }
    return { ...base, scores };
  }

  if (proposal.type === 'ranked-choice') {
    // Instant runoff: drop the weakest choice until one has a majority of the VP cast.
    const eliminated = new Set();
    const rounds = [];
    for (;;) {
      const scores = new Array(n).fill(0);
      for (const v of votes) {
        const top = v.choice.find((c) => !eliminated.has(c));
        if (top) scores[top - 1] += v.vp;
      }
      rounds.push(scores);
      const live = scores.map((s, i) => [s, i + 1]).filter(([, c]) => !eliminated.has(c));
      const leader = live.reduce((a, b) => (b[0] > a[0] ? b : a), live[0]);
      if (!leader || leader[0] * 2 > total || live.length <= 1 || total === 0) {
        return { ...base, scores, rounds, winner: leader && leader[0] > 0 ? leader[1] : null };
      }
      // Ties for last: eliminate the highest-numbered so results are deterministic.
      const min = Math.min(...live.map(([s]) => s));
      const out = live.filter(([s]) => s === min).map(([, c]) => c);
      eliminated.add(Math.max(...out));
    }
  }

  throw new Error(`unsupported voting type ${proposal.type}`);
}

/** Poll totals count wallets; quorum (if any) is a voter count. */
function pollBase(proposal, votes) {
  return {
    scoresTotal: votes.length,
    votes: votes.length,
    vpTotal: votes.reduce((t, v) => t + v.vp, 0),
    quorum: proposal.quorum,
    quorumReached: votes.length >= proposal.quorum,
    unit: 'voters',
  };
}

/** Turnout-only result for a shielded proposal whose votes are still sealed. */
function hiddenTally(proposal, votes) {
  if (proposal.type === 'poll') return { ...pollBase(proposal, votes), scores: null, hidden: true };
  const total = votes.reduce((t, v) => t + v.vp, 0);
  return {
    scoresTotal: total,
    votes: votes.length,
    quorum: proposal.quorum,
    quorumReached: total >= proposal.quorum,
    scores: null,
    hidden: true,
  };
}

module.exports = {
  hiddenTally,
  VOTE_TYPES,
  canonicalJson,
  proposalId,
  validateChoice,
  verifyVoteSignature,
  checkVote,
  tally,
};
