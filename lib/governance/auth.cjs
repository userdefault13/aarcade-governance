/**
 * Proposer sessions for /dao/propose. Same flow as lib/adminSession.cjs (sign one message,
 * get an 8h Bearer token) but open to every proposer — DAO staff, members on the admin DAO
 * "Proposers" tab, and the Aarcade owner — not just admin_users.
 *
 * An admin session token is accepted too, so the admin DAO workspace keeps working.
 * Roles are re-read on every request: removing a member revokes access on their next call.
 */
const jwt = require('jsonwebtoken');
const { verifyMessage } = require('ethers');
const { getSessionSecret } = require('../adminSession.cjs');
const { getAdminUsersCollection } = require('../mongodb.cjs');
const SPACE = require('./space.config.cjs');
const store = require('./store.cjs');
const { canSignIn } = require('./permissions.cjs');

const SESSION_TTL_SEC = 8 * 60 * 60;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const SCOPE = 'aarcade-governance';
const ADMIN_SCOPE = 'aarcade-admin';

function normWallet(v) {
  const w = String(v || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(w) ? w : null;
}

function sessionMessage(wallet, issuedAt) {
  return [
    'Aarcade Governance',
    '',
    'Sign in to create and manage DAO proposals.',
    'This signature does not send a transaction or cost gas.',
    '',
    `Wallet: ${wallet}`,
    `Issued: ${issuedAt}`,
  ].join('\n');
}

const userTypeOf = (admin) => String(admin?.userType || '').toLowerCase();

/**
 * Put an auto-whitelisted staff wallet (hackathon council) on the Proposers list the first
 * time it's seen. Never re-adds a wallet the owner removed.
 * @returns {Promise<boolean>} true if the wallet is now an active proposer because of this
 */
async function autoWhitelist(wallet, admin) {
  const userType = userTypeOf(admin);
  if (!SPACE.autoWhitelistUserTypes.includes(userType)) return false;
  if (await store.getProposerRecord(wallet)) return false;
  await store.setProposer(wallet, {
    label: admin?.displayName || admin?.name || 'Hackathon council',
    active: true,
    addedBy: `auto:${userType}`,
    addedAt: Math.floor(Date.now() / 1000),
    auto: true,
  });
  return true;
}

/** Whitelist every auto-whitelisted staff wallet not yet on the list (admin Proposers tab). */
async function syncAutoWhitelist() {
  const admins = await (await getAdminUsersCollection())
    .find({ userType: { $in: SPACE.autoWhitelistUserTypes } })
    .toArray();
  let added = 0;
  for (const admin of admins) {
    const wallet = normWallet(admin.walletAddress);
    if (wallet && (await autoWhitelist(wallet, admin))) added += 1;
  }
  return added;
}

/** @returns {Promise<{ wallet: string, owner: boolean, staff: boolean, member: boolean }>} */
async function rolesFor(wallet) {
  const [admin, member] = await Promise.all([
    (await getAdminUsersCollection()).findOne({ walletAddress: wallet }),
    store.getProposer(wallet),
  ]);
  return {
    wallet,
    owner: wallet === SPACE.ownerAddress,
    staff: SPACE.proposerUserTypes.includes(userTypeOf(admin)),
    member: Boolean(member) || (await autoWhitelist(wallet, admin)),
  };
}

function createSessionMessage(walletInput) {
  const wallet = normWallet(walletInput);
  if (!wallet) return { ok: false, status: 400, error: 'wallet required' };
  const issuedAt = new Date().toISOString();
  return { ok: true, message: sessionMessage(wallet, issuedAt), issuedAt };
}

async function issueSession(body) {
  const secret = getSessionSecret();
  if (!secret) return { ok: false, status: 503, error: 'Sessions are not configured (ADMIN_SESSION_SECRET)' };
  const wallet = normWallet(body?.wallet);
  const issuedAtMs = Date.parse(body?.issuedAt);
  if (!wallet || !body?.signature || !Number.isFinite(issuedAtMs)) {
    return { ok: false, status: 400, error: 'wallet, issuedAt and signature required' };
  }
  if (Math.abs(Date.now() - issuedAtMs) > MAX_SIGNATURE_AGE_MS) return { ok: false, status: 401, error: 'Signature expired — sign again' };
  let recovered;
  try {
    recovered = verifyMessage(sessionMessage(wallet, body.issuedAt), body.signature).toLowerCase();
  } catch {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  if (recovered !== wallet) return { ok: false, status: 401, error: 'Signature does not match wallet' };
  const roles = await rolesFor(wallet);
  if (!canSignIn(roles)) return { ok: false, status: 403, error: 'This wallet is not on the DAO proposer whitelist' };
  const token = jwt.sign({ wallet, scope: SCOPE }, secret, { expiresIn: SESSION_TTL_SEC });
  return { ok: true, token, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString(), roles };
}

/**
 * Resolve the caller from a proposer or admin Bearer token.
 * @returns {Promise<{ ok: true, actor: { wallet, owner, staff, member } } | { ok: false, status: number, error: string }>}
 */
async function authorizeActor(req) {
  const secret = getSessionSecret();
  if (!secret) return { ok: false, status: 503, error: 'Sessions are not configured (ADMIN_SESSION_SECRET)' };
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Sign in with your wallet first' };
  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return { ok: false, status: 401, error: 'Session expired — sign in again' };
  }
  const wallet = normWallet(payload?.wallet);
  if (!wallet || (payload?.scope !== SCOPE && payload?.scope !== ADMIN_SCOPE)) return { ok: false, status: 401, error: 'Invalid session' };
  const actor = await rolesFor(wallet);
  if (!canSignIn(actor)) return { ok: false, status: 403, error: 'This wallet is no longer on the DAO proposer whitelist' };
  return { ok: true, actor };
}

module.exports = { sessionMessage, createSessionMessage, issueSession, authorizeActor, rolesFor, normWallet, syncAutoWhitelist };
