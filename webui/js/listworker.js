// Web Worker: fetches a library source's extended list (/api/v1/lists/<id>),
// parses it off the page's thread and answers with the pictures of each entry
// for the result rows (several for a menu disk: the page cycles them).
// Inline pictures are checked by their first bytes (PNG, JPEG, WebP, GIF
// only, at most 256 KB) and sent as data: URLs; src pictures as their
// number, for /api/v1/media/<source>/<entry>/<n>. Nothing here
// talks to any server but the CosmosEx.
const MAX_BYTES = 256 * 1024;
const MAX_MEDIA = 16;

function typeOf(b64) {
  let head;
  try { head = atob(b64.slice(0, 24)); } catch (e) { return null; }
  const c = (i) => head.charCodeAt(i);
  if (c(0) === 0x89 && head.slice(1, 4) === 'PNG') return 'image/png';
  if (c(0) === 0xff && c(1) === 0xd8 && c(2) === 0xff) return 'image/jpeg';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// the entry's media items in document order (entry, then each game), as the CosmosEx numbers them
function mediaOf(e) {
  const all = Array.isArray(e.media) ? [...e.media] : [];
  for (const g of Array.isArray(e.games) ? e.games : []) {
    if (g && typeof g === 'object' && Array.isArray(g.media)) all.push(...g.media);
  }
  return all.slice(0, MAX_MEDIA);
}

const MAX_SHOWN = 12;         // pictures cycled in one thumbnail (menu disks)

function asPicture(m, n) {
  const caption = typeof m.caption === 'string' ? m.caption : '';
  if (typeof m.data === 'string') {
    const b64 = m.data.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
    if (b64.length * 0.75 > MAX_BYTES) return null;
    const type = typeOf(b64);
    return type ? { url: `data:${type};base64,${b64}`, caption } : null;
  }
  if (typeof m.src === 'string' && m.src) return { n, caption };
  return null;
}

const SHOWN_ROLES = ['thumbnail', 'title', 'screenshot', 'box'];

// The entry's pictures for the result row: the list picture first (first
// thumbnail, else title, else screenshot, else box), then the others in list
// order (e.g. each game's screenshot or cover on a menu disk); "other" is
// left out
function pick(e) {
  const media = mediaOf(e);
  let first = -1;
  for (const role of SHOWN_ROLES) {
    first = media.findIndex((m) => m && m.role === role && asPicture(m, 0));
    if (first >= 0) break;
  }
  if (first < 0) return null;
  const order = [first, ...media.map((_, i) => i).filter((i) => i !== first)];
  const out = [];
  for (const i of order) {
    const m = media[i];
    if (!m || !SHOWN_ROLES.includes(m.role)) continue;
    const p = asPicture(m, i);
    if (p) out.push(p);
    if (out.length >= MAX_SHOWN) break;
  }
  return out;
}

self.onmessage = async (ev) => {
  const { sourceId } = ev.data;
  try {
    const r = await fetch(`/api/v1/lists/${encodeURIComponent(sourceId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json();
    const pics = {};
    for (const e of Array.isArray(list.entries) ? list.entries : []) {
      if (!e || typeof e.id !== 'string') continue;
      const p = pick(e);
      if (p) pics[e.id] = p;
    }
    self.postMessage({ sourceId, pics });
  } catch (e) {
    self.postMessage({ sourceId, pics: {}, error: String(e.message || e) });
  }
};
