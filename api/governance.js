/**
 * Self-hosted governance (replaces the Snapshot hub for aavegotchi.eth).
 *
 *   GET  /api/governance?action=space
 *   GET  /api/governance?action=proposals[&limit&skip&electionId]
 *   GET  /api/governance?action=proposal&id=0x…          proposal + results + votes
 *   GET  /api/governance?action=vp&voter=0x…[&id=0x…]     VP now, or at a proposal's snapshot
 *   GET  /api/governance?action=voted&voter=0x…           proposal ids this wallet voted on
 *   GET  /api/governance?action=vote&id=0x…&voter=0x…     this wallet's current vote
 *   POST /api/governance?action=vote        { message, signature }   (EIP-712, see lib/governance/votes.cjs)
 *   GET  /api/governance?action=archive[&limit&skip]       archived Snapshot proposals (lib/governance/snapshotArchive.cjs)
 *   GET  /api/governance?action=archive-proposal&id=0x…[&limit&skip]   one, with final scores + votes
 *   GET  /api/governance?action=archive-space            space name / about / counts at archive time
 *   POST /api/governance?action=names       { addresses: [0x…] } → { names: { 0x…: 'name.eth' | '' } } (≤ 500)
 *   GET  /api/governance?action=roles&wallet=0x…          { owner, staff, member, canPropose }
 *   GET  /api/governance?action=session-message&wallet=0x… proposer sign-in message
 *   POST /api/governance?action=session     { wallet, issuedAt, signature } → { token, expiresAt, roles }
 *   POST /api/governance?action=propose     proposer session (Bearer) — Proposers whitelist + owner; staff for election ballots only
 *   POST /api/governance?action=edit        proposer session — { id, ...fields } (lib/governance/permissions.cjs)
 *   POST /api/governance?action=cancel      proposer session — { id }
 *   POST /api/governance?action=update      admin session — { id, lensPostId } or { id, cancelled: true }
 *   GET  /api/governance?action=proposers                 admin session — Proposers tab
 *   POST /api/governance?action=proposers-add             admin session — { address, label? }
 *   POST /api/governance?action=proposers-remove          admin session — { address }
 */
import 'dotenv/config';
import { createRequire } from 'module';
import { authorizeAdmin } from '../lib/adminSession.cjs';

const require = createRequire(import.meta.url);
const service = require('../lib/governance/service.cjs');
const auth = require('../lib/governance/auth.cjs');
const { canPropose } = require('../lib/governance/permissions.cjs');
const SPACE = require('../lib/governance/space.config.cjs');
const { VOTE_TYPES } = require('../lib/governance/votes.cjs');
const { resolveNames } = require('../lib/governance/names.cjs');

export const config = { maxDuration: 300 };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ID_RE = /^0x[0-9a-fA-F]{64}$/;
/** Archived Snapshot proposals also include legacy IPFS ids (Qm…, case-sensitive). */
const ARCHIVE_ID_RE = /^(0x[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, result) {
  if (result && result.ok === false) return res.status(result.status || 400).json({ error: result.error });
  return res.status(200).json(result);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

async function requireProposer(req) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return auth;
  if (!service.canPropose(auth.admin)) return { ok: false, status: 403, error: 'Only DAO staff can create proposals' };
  return auth;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const q = req.query || {};
  const action = String(q.action || '');

  try {
    if (req.method === 'GET') {
      if (action === 'space') {
        return send(res, {
          ok: true,
          space: {
            id: SPACE.id,
            name: SPACE.name,
            chainId: SPACE.chainId,
            quorum: SPACE.quorum,
            votingTypes: SPACE.votingTypes,
            privacyModes: SPACE.privacyModes,
            strategies: SPACE.strategies.map((s) => s.label),
            eip712: { domain: SPACE.eip712Domain, types: VOTE_TYPES },
          },
        });
      }
      if (action === 'proposals') {
        const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
        const skip = Math.max(0, Number(q.skip) || 0);
        const electionId = /^[a-z0-9-]{3,64}$/.test(String(q.electionId || '')) ? String(q.electionId) : undefined;
        const category = SPACE.categories.some((c) => c.id === q.category) ? String(q.category) : undefined;
        const author = ADDRESS_RE.test(String(q.author || '')) ? String(q.author).toLowerCase() : undefined;
        return send(res, await service.listProposals({ limit, skip, electionId, category, author }));
      }
      if (action === 'proposal') {
        if (!ID_RE.test(String(q.id || ''))) return send(res, { ok: false, status: 400, error: 'id required' });
        return send(res, await service.getResults(String(q.id).toLowerCase()));
      }
      if (action === 'voted') {
        if (!ADDRESS_RE.test(String(q.voter || ''))) return send(res, { ok: false, status: 400, error: 'voter required' });
        return send(res, await service.votedProposalIds(String(q.voter).toLowerCase()));
      }
      if (action === 'vote') {
        if (!ARCHIVE_ID_RE.test(String(q.id || '')) || !ADDRESS_RE.test(String(q.voter || ''))) {
          return send(res, { ok: false, status: 400, error: 'id and voter required' });
        }
        return send(res, await service.getVote(String(q.id), String(q.voter).toLowerCase()));
      }
      if (action === 'archive') {
        const limit = Math.min(1000, Math.max(1, Number(q.limit) || 50));
        const skip = Math.max(0, Number(q.skip) || 0);
        return send(res, await service.listArchive({ limit, skip }));
      }
      if (action === 'archive-space') return send(res, await service.archiveSpace());
      if (action === 'archive-proposal') {
        if (!ARCHIVE_ID_RE.test(String(q.id || ''))) return send(res, { ok: false, status: 400, error: 'id required' });
        const limit = Math.min(1000, Math.max(1, Number(q.limit) || 100));
        const skip = Math.max(0, Number(q.skip) || 0);
        return send(res, await service.getArchive(String(q.id), { limit, skip }));
      }
      if (action === 'roles') {
        const wallet = auth.normWallet(q.wallet);
        if (!wallet) return send(res, { ok: false, status: 400, error: 'wallet required' });
        const roles = await auth.rolesFor(wallet);
        return send(res, { ok: true, ...roles, canPropose: canPropose(roles) });
      }
      if (action === 'session-message') return send(res, auth.createSessionMessage(q.wallet));
      if (action === 'proposers') {
        const admin = await requireProposer(req);
        if (!admin.ok) return send(res, admin);
        await auth.syncAutoWhitelist(); // hackathon council wallets show up on the list
        return send(res, await service.listProposers());
      }
      if (action === 'vp') {
        if (!ADDRESS_RE.test(String(q.voter || ''))) return send(res, { ok: false, status: 400, error: 'voter required' });
        const id = q.id && ID_RE.test(String(q.id)) ? String(q.id).toLowerCase() : null;
        return send(res, await service.voterVp(String(q.voter).toLowerCase(), id));
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (action === 'vote') return send(res, await service.castVote(body));
      if (action === 'names') return send(res, await resolveNames(body.addresses));
      if (action === 'session') return send(res, await auth.issueSession(body));
      if (action === 'propose') {
        const who = await auth.authorizeActor(req);
        if (!who.ok) return send(res, who);
        if (body.electionId && !who.actor.staff && !who.actor.owner) {
          return send(res, { ok: false, status: 403, error: 'Only DAO staff can create election ballots' });
        }
        if (!body.electionId && !canPropose(who.actor)) {
          return send(res, { ok: false, status: 403, error: 'Only whitelisted wallets (admin DAO → Proposers) can create proposals' });
        }
        return send(res, await service.createProposal({ ...body, author: who.actor.wallet }));
      }
      if (action === 'edit' || action === 'cancel') {
        const who = await auth.authorizeActor(req);
        if (!who.ok) return send(res, who);
        if (!ID_RE.test(String(body.id || ''))) return send(res, { ok: false, status: 400, error: 'id required' });
        const id = String(body.id).toLowerCase();
        if (action === 'cancel') return send(res, await service.cancelProposal(id, who.actor));
        const { id: _id, ...patch } = body;
        return send(res, await service.editProposal(id, patch, who.actor));
      }
      if (action === 'update') {
        const admin = await requireProposer(req);
        if (!admin.ok) return send(res, admin);
        if (!ID_RE.test(String(body.id || ''))) return send(res, { ok: false, status: 400, error: 'id required' });
        const id = String(body.id).toLowerCase();
        // Cancelling follows the same rules as action=cancel (author / staff for ballots / owner).
        if (body.cancelled === true) return send(res, await service.cancelProposal(id, await auth.rolesFor(admin.wallet)));
        return send(res, await service.updateProposalMeta(id, { lensPostId: body.lensPostId }));
      }
      if (action === 'proposers-add' || action === 'proposers-remove') {
        const admin = await requireProposer(req);
        if (!admin.ok) return send(res, admin);
        if (action === 'proposers-add') return send(res, await service.addProposer(body, admin.wallet));
        return send(res, await service.removeProposer(body.address, admin.wallet));
      }
    }

    return send(res, { ok: false, status: 404, error: `unknown action ${req.method} ${action}` });
  } catch (e) {
    console.error('[governance]', e);
    return send(res, { ok: false, status: 500, error: 'Governance request failed' });
  }
}
