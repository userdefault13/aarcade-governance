/**
 * Who may create, edit or cancel which proposal. Pure functions — the caller resolves the
 * actor's roles (auth.cjs) and whether the proposal has votes (store.hasVotes).
 *
 *   actor = { wallet, owner, staff, member }
 *     owner   the Aarcade owner wallet (SPACE.ownerAddress) — may change any proposal
 *     staff   admin_users with a SPACE.proposerUserTypes role — election ballots only
 *     member  wallet added on the admin DAO "Proposers" tab (the proposal whitelist)
 */

/** Fields anyone allowed to edit may change once voting has started or votes exist. */
const TEXT_FIELDS = ['title', 'body', 'discussion'];
/** Fields that change what is being voted on — only before voting starts and with no votes. */
const BALLOT_FIELDS = ['category', 'sigpropId', 'choices', 'type', 'privacy', 'start', 'end'];

const deny = (status, error) => ({ ok: false, status, error });

/**
 * SigProps, Core AGIPs and Polls: only wallets on the Proposers whitelist, plus the owner.
 * Staff aren't proposers by role; hackathon council wallets are whitelisted automatically
 * (auth.cjs autoWhitelist), the rest by hand.
 */
function canPropose(actor) {
  return Boolean(actor?.owner || actor?.member);
}

/** Proposer sessions: proposers, plus staff (they still create election ballots). */
function canSignIn(actor) {
  return Boolean(canPropose(actor) || actor?.staff);
}

function isAuthor(proposal, actor) {
  return Boolean(actor?.wallet) && String(proposal.author).toLowerCase() === actor.wallet;
}

/**
 * @param {'pending'|'active'|'closed'|'cancelled'} state  service.proposalState(proposal)
 * @returns {{ ok: true, fields: string[] } | { ok: false, status: number, error: string }}
 */
function editableFields(proposal, actor, { state, hasVotes }) {
  if (state === 'cancelled') return deny(409, 'proposal is cancelled');
  if (state === 'closed') return deny(409, 'voting has closed');
  if (proposal.electionId) return deny(403, 'election ballots are managed from the admin DAO Elections tab');
  const ballotOpen = state === 'pending' && !hasVotes;
  if (actor?.owner) return { ok: true, fields: ballotOpen ? [...TEXT_FIELDS, ...BALLOT_FIELDS] : TEXT_FIELDS };
  if (!isAuthor(proposal, actor) || !canPropose(actor)) return deny(403, 'only the author or the Aarcade owner can edit this proposal');
  if (!ballotOpen) return deny(409, 'voting has started — only the Aarcade owner can edit it now');
  return { ok: true, fields: [...TEXT_FIELDS, ...BALLOT_FIELDS] };
}

/** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
function canCancel(proposal, actor, { state }) {
  if (state === 'cancelled') return deny(409, 'proposal is already cancelled');
  if (state === 'closed') return deny(409, 'voting has closed');
  if (actor?.owner) return { ok: true };
  // Election ballots: any DAO staff, as before (admin DAO Elections tab).
  if (proposal.electionId) return actor?.staff ? { ok: true } : deny(403, 'only DAO staff can cancel an election ballot');
  if (isAuthor(proposal, actor) && canPropose(actor)) return { ok: true };
  return deny(403, 'only the author or the Aarcade owner can cancel this proposal');
}

module.exports = { TEXT_FIELDS, BALLOT_FIELDS, canPropose, canSignIn, editableFields, canCancel };
