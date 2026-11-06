/**
 * Signed admin sessions for admin-only API routes (admin-settings, meetings).
 *
 * Replaces "wallet address as credential" (Authorization: <address> / ?walletAddress=),
 * which anyone could forge because addresses are public. Now:
 *
 *   1. GET  /api/admin-settings/session-message?wallet=0x…   → { message, issuedAt }
 *   2. Admin signs `message` (personal_sign).
 *   3. POST /api/admin-settings/session { wallet, issuedAt, signature } → { token, expiresAt }
 *   4. Admin calls send `Authorization: Bearer <token>`.
 *
 * Every authorized call re-checks admin_users, so removing an admin revokes access on their
 * next request. Env: ADMIN_SESSION_SECRET (required in production; routes fail closed without it).
 */
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { verifyMessage } = require('ethers');
const { getAdminUsersCollection } = require('./mongodb.cjs');

const SESSION_TTL_SEC = 8 * 60 * 60;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const SCOPE = 'aarcade-admin';

let devSecret = null;

/** Production must configure a secret; local dev gets a per-process one (sessions reset on restart). */
function getSecret() {
  const s = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (s) return s;
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (isProd) return null;
  if (!devSecret) {
    devSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[adminSession] ADMIN_SESSION_SECRET not set — using an ephemeral dev secret');
  }
  return devSecret;
}

function normWallet(v) {
  const w = String(v || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(w) ? w : null;
}

function sessionMessage(wallet, issuedAt) {
  return [
    'Aarcade Admin',
    '',
    'Sign in to use the Aarcade admin tools.',
    'This signature does not send a transaction or cost gas.',
    '',
    `Wallet: ${wallet}`,
    `Issued: ${issuedAt}`,
  ].join('\n');
}

async function findAdmin(wallet) {
  const col = await getAdminUsersCollection();
  return col.findOne({ walletAddress: wallet });
}

function createSessionMessage(walletInput) {
  const wallet = normWallet(walletInput);
  if (!wallet) return { ok: false, status: 400, error: 'wallet required' };
  const issuedAt = new Date().toISOString();
  return { ok: true, message: sessionMessage(wallet, issuedAt), issuedAt };
}

async function issueAdminSession(body) {
  const secret = getSecret();
  if (!secret) return { ok: false, status: 503, error: 'Admin sessions are not configured (ADMIN_SESSION_SECRET)' };
  const wallet = normWallet(body?.wallet);
  const issuedAtMs = Date.parse(body?.issuedAt);
  if (!wallet || !body?.signature || !Number.isFinite(issuedAtMs)) {
    return { ok: false, status: 400, error: 'wallet, issuedAt and signature required' };
  }
  if (Math.abs(Date.now() - issuedAtMs) > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, status: 401, error: 'Signature expired — sign again' };
  }
  let recovered;
  try {
    recovered = verifyMessage(sessionMessage(wallet, body.issuedAt), body.signature).toLowerCase();
  } catch {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  if (recovered !== wallet) return { ok: false, status: 401, error: 'Signature does not match wallet' };
  if (!(await findAdmin(wallet))) return { ok: false, status: 403, error: 'Not an admin wallet' };
  const token = jwt.sign({ wallet, scope: SCOPE }, secret, { expiresIn: SESSION_TTL_SEC });
  return { ok: true, token, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString() };
}

/**
 * Authorize an admin request from its Bearer session token.
 * @returns {Promise<{ok: true, wallet: string, admin: object} | {ok: false, status: number, error: string}>}
 */
async function authorizeAdmin(req, { founder = false } = {}) {
  const secret = getSecret();
  if (!secret) return { ok: false, status: 503, error: 'Admin sessions are not configured (ADMIN_SESSION_SECRET)' };
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Admin session required — sign in again' };
  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return { ok: false, status: 401, error: 'Admin session expired — sign in again' };
  }
  const wallet = normWallet(payload?.wallet);
  if (payload?.scope !== SCOPE || !wallet) return { ok: false, status: 401, error: 'Invalid admin session' };
  const admin = await findAdmin(wallet);
  if (!admin) return { ok: false, status: 403, error: 'Not an admin wallet' };
  if (founder && admin.userType !== 'founder') return { ok: false, status: 403, error: 'Founder only' };
  return { ok: true, wallet, admin };
}

/** Express middleware form of authorizeAdmin. Sets req.adminWallet. */
function requireAdminSession(opts) {
  return async (req, res, next) => {
    try {
      const auth = await authorizeAdmin(req, opts);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      req.adminWallet = auth.wallet;
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = {
  getSessionSecret: getSecret,
  sessionMessage,
  createSessionMessage,
  issueAdminSession,
  authorizeAdmin,
  requireAdminSession,
};
