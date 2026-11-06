/**
 * Public, immutable audit copies on Grove (Lens storage): proposals, frozen VP tables and
 * every signed vote. Anyone can fetch them and recount, so the operator can't quietly
 * drop or alter a vote. Best-effort: Mongo stays canonical; a failed upload leaves
 * `groveUri: null` for a later backfill instead of rejecting the vote.
 *
 * GOVERNANCE_GROVE=0 disables uploads (local dev / tests).
 */
const { StorageClient, production, immutable } = require('@lens-chain/storage-client');

const LENS_MAINNET_CHAIN_ID = 232;
let client = null;

function enabled() {
  return String(process.env.GOVERNANCE_GROVE ?? '1').trim() !== '0';
}

/** @returns {Promise<string | null>} lens:// uri, or null when disabled / failed */
async function uploadJson(data) {
  if (!enabled()) return null;
  try {
    client = client || StorageClient.create(production);
    const res = await client.uploadAsJson(data, { acl: immutable(LENS_MAINNET_CHAIN_ID) });
    return res.uri;
  } catch (e) {
    console.warn('[governance] Grove upload failed:', e?.message || e);
    return null;
  }
}

module.exports = { uploadJson, enabled };
