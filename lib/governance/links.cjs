/**
 * Discussion links on a proposal: up to MAX_LINKS http(s) URLs, entered separated by ";"
 * (newlines and spaces also split). Stored as one string joined with " ; " so the
 * Snapshot-shaped `discussion` field stays a string; readers split it again.
 */
const MAX_LINKS = 3;
const MAX_LINK = 512;
const SEPARATOR = ' ; ';

const splitLinks = (raw) =>
  String(raw || '')
    .split(/[;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** @returns {{ ok: true, value: string } | { ok: false, error: string }} */
function normalizeDiscussion(raw) {
  const links = [...new Set(splitLinks(raw))];
  if (links.length > MAX_LINKS) return { ok: false, error: `at most ${MAX_LINKS} discussion links` };
  for (const link of links) {
    let url;
    try {
      url = new URL(link);
    } catch {
      url = null;
    }
    if (!url || !/^https?:$/.test(url.protocol) || link.length > MAX_LINK) {
      return { ok: false, error: `discussion link must be an http(s) URL (≤ ${MAX_LINK} chars): ${link.slice(0, 80)}` };
    }
  }
  return { ok: true, value: links.join(SEPARATOR) };
}

module.exports = { MAX_LINKS, splitLinks, normalizeDiscussion };
