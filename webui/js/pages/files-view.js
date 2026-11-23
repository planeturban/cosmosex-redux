// The Files page's viewer and editor (F3): text in the Atari ST's character
// set, Degas (.PI1-3, compressed .PC1-3) and NEOchrome (.NEO) pictures drawn
// here, PNG / JPEG / GIF / WebP / BMP as they are, anything as hex. Edit (text
// or hex) saves the file back, for files up to EDIT_MAX in a writable place.
// Text is lossless both ways: control bytes shown as their Unicode symbols
// (␀..␟, ␡), the file's line endings kept (CR LF files saved with CR LF; a
// lone CR shown as ␍), characters TOS has no code for refused when saving.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TEXT_MAX = 512 * 1024;
const EDIT_MAX = TEXT_MAX;
const IMG_MAX = 8 * 1024 * 1024;

// the Atari ST character set, 0x80-0xFF (0x00-0x7F: ASCII)
const ATARI_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥ßƒáíóúñÑªº¿⌐¬½¼¡«»ãõØøœŒÀÃÕ¨´†¶©®™ĳĲאבגדהוזחטיכלמנסעפצקרשת'
  + 'ןךםףץ§∧∞αβΓπΣσµτΦΘΩδ∮ϕ∈∩≡±≥≤⌠⌡÷≈°•·√ⁿ²³¯';
const HIGH_BYTE = new Map([...ATARI_HIGH].map((c, i) => [c, 0x80 + i]));
const CTRL = (b) => String.fromCharCode(b === 127 ? 0x2421 : 0x2400 + b);      // ␀ .. ␟, ␡
const atariChar = (b) => (b >= 0x80 ? ATARI_HIGH[b - 0x80] : b === 9 || b === 10 ? String.fromCharCode(b) : b < 32 || b === 127 ? CTRL(b) : String.fromCharCode(b));

// line endings: 'crlf' (every LF after a CR, no other CR), 'lf', or 'raw' (CR shown as ␍)
function lineMode(bytes) {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) { lf++; if (i && bytes[i - 1] === 13) crlf++; }
    if (bytes[i] === 13) cr++;
  }
  if (lf && crlf === lf && cr === crlf) return 'crlf';
  return cr ? 'raw' : 'lf';
}

export function atariText(bytes, mode = lineMode(bytes)) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (mode === 'crlf' && b === 13 && bytes[i + 1] === 10) continue;     // CR LF -> LF
    s += atariChar(b);
  }
  return s;
}

// text -> the file's bytes; throws with the characters TOS has no code for
export function atariBytes(text, mode) {
  const out = [];
  const bad = new Set();
  for (const c of text) {
    const u = c.codePointAt(0);
    if (c === '\n') { if (mode === 'crlf') out.push(13); out.push(10); } else if (u === 9) out.push(9);
    else if (u >= 32 && u < 127) out.push(u);
    else if (u >= 0x2400 && u < 0x2420) out.push(u - 0x2400);
    else if (u === 0x2421) out.push(127);
    else if (HIGH_BYTE.has(c)) out.push(HIGH_BYTE.get(c));
    else if (u === 13) out.push(13);
    else bad.add(c);
  }
  if (bad.size) throw new Error(`The Atari character set has no code for: ${[...bad].slice(0, 12).join(' ')}${bad.size > 12 ? ' …' : ''}`);
  return new Uint8Array(out);
}

function looksText(bytes) {
  const n = Math.min(bytes.length, 8192);
  if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 26 && b !== 27)) bad++;
  }
  return bad / n < 0.02;
}

const hex2 = (b) => b.toString(16).padStart(2, '0');

function hexDump(bytes) {
  const out = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const row = bytes.subarray(o, o + 16);
    out.push(`${o.toString(16).padStart(8, '0')}  ${[...row].map(hex2).join(' ').padEnd(47)}  ${[...row].map((b) => (b >= 32 && b !== 127 ? atariChar(b) : '.')).join('')}`);
  }
  return out.join('\n');
}

// hex editing: 16 bytes a line, pairs of hex digits; whitespace free
const hexLines = (bytes) => {
  const out = [];
  for (let o = 0; o < bytes.length; o += 16) out.push([...bytes.subarray(o, o + 16)].map(hex2).join(' '));
  return out.join('\n');
};

export function parseHex(text) {
  const out = [];
  const lines = text.split('\n');
  for (let l = 0; l < lines.length; l++) {
    const t = lines[l].replace(/\s+/g, '');
    if (t.length % 2 || /[^0-9a-f]/i.test(t)) throw new Error(`Line ${l + 1}: hex digits in pairs only (${lines[l].trim().slice(0, 40)}).`);
    for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
}

/* ------------------------------------------------------------- pictures */

const be16 = (d, o) => (d[o] << 8) | d[o + 1];

// palette word -> [r, g, b]: ST 3 bits per colour (7 = full); STE a 4th bit,
// the lowest one, kept in bit 3 (used when any colour has it)
const stRGB = (w, ste) => [8, 4, 0].map((sh) => {
  const v = (w >> sh) & 15;
  return ste ? (((v & 7) << 1) | (v >> 3)) * 17 : Math.round(((v & 7) * 255) / 7);
});

const MODES = { 0: { w: 320, h: 200, planes: 4, sx: 2, sy: 2 }, 1: { w: 640, h: 200, planes: 2, sx: 1, sy: 2 }, 2: { w: 640, h: 400, planes: 1, sx: 1, sy: 1 } };

// 32000 bytes of interleaved bitplanes -> RGBA
function planarToRGBA(data, off, res, palette) {
  const m = MODES[res];
  const px = new Uint8ClampedArray(m.w * m.h * 4);
  const lineBytes = (m.w * m.planes) / 8;
  const ste = palette.some((w) => w & 0x888);
  const colours = palette.map((w) => stRGB(w, ste));
  if (res === 2) {                                          // mono: bit 0 of colour 0 picks the background
    const white = [255, 255, 255];
    const black = [0, 0, 0];
    colours[0] = palette[0] & 1 ? white : black;
    colours[1] = palette[0] & 1 ? black : white;
  }
  for (let y = 0; y < m.h; y++) {
    for (let g = 0; g < m.w / 16; g++) {
      const base = off + y * lineBytes + g * m.planes * 2;
      const words = [];
      for (let p = 0; p < m.planes; p++) words.push(be16(data, base + p * 2));
      for (let bit = 0; bit < 16; bit++) {
        let c = 0;
        for (let p = 0; p < m.planes; p++) c |= ((words[p] >> (15 - bit)) & 1) << p;
        const [r, gg, b] = colours[c] || [0, 0, 0];
        const i = (y * m.w + g * 16 + bit) * 4;
        px[i] = r; px[i + 1] = gg; px[i + 2] = b; px[i + 3] = 255;
      }
    }
  }
  return { ...m, px };
}

// Degas Elite compressed (.PC1-3): PackBits, each scan line's planes one after the other
function unpackPC(data, res) {
  const m = MODES[res];
  const planeLine = m.w / 8;                                // bytes of one plane in one line
  const out = new Uint8Array(32000);
  let src = 34;
  for (let y = 0; y < m.h; y++) {
    const line = new Uint8Array(planeLine * m.planes);
    let n = 0;
    while (n < line.length && src < data.length) {
      const c = data[src++];
      if (c < 128) { for (let k = 0; k <= c && n < line.length; k++) line[n++] = data[src++]; } else if (c > 128) { const v = data[src++]; for (let k = 0; k < 257 - c && n < line.length; k++) line[n++] = v; }
    }
    // planes separate -> interleaved words
    for (let g = 0; g < m.w / 16; g++) {
      for (let p = 0; p < m.planes; p++) {
        const o = y * planeLine * m.planes + (g * m.planes + p) * 2;
        out[o] = line[p * planeLine + g * 2];
        out[o + 1] = line[p * planeLine + g * 2 + 1];
      }
    }
  }
  return out;
}

function palette16(d, off) {
  const p = [];
  for (let i = 0; i < 16; i++) p.push(be16(d, off + i * 2));
  return p;
}

// a picture the viewer can draw, or null
export function decodeAtariPicture(name, d) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (/^pi[123]$/.test(ext) && d.length >= 32034) {
    const res = be16(d, 0) & 3;
    if (!MODES[res]) return null;
    return planarToRGBA(d, 34, res, palette16(d, 2));
  }
  if (/^pc[123]$/.test(ext) && d.length > 34) {
    const res = be16(d, 0) & 3;
    if (!MODES[res]) return null;
    return planarToRGBA(unpackPC(d, res), 0, res, palette16(d, 2));
  }
  if (ext === 'neo' && d.length >= 32128) {
    const res = be16(d, 2) & 3;
    if (!MODES[res]) return null;
    return planarToRGBA(d, 128, res, palette16(d, 4));
  }
  return null;
}

const ATARI_PIC = /\.(pi[123]|pc[123]|neo)$/i;
const WEB_PIC = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

/* --------------------------------------------------------------- dialog */

let blobUrl = null;
let reading = null;              // the read in flight (an AbortController): one at a time

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

// the file's bytes, the bar moving as they arrive (the answer has no length:
// 'expect' is what the listing said, cut at what was asked for)
async function readBytes(url, expect, signal, onProgress) {
  const r = await fetch(url, { cache: 'no-store', signal });
  if (!r.ok) {
    let m = `HTTP ${r.status}`;
    try { m = (await r.json()).error || m; } catch (e) { /* not JSON */ }
    throw new Error(m);
  }
  if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, expect);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// opts: {name, size, url(max) -> the read URL, downloadUrl, onPrev, onNext,
//        save(bytes) -> Promise (absent: can't edit), readOnly: why it can't be edited}
export async function showViewer(dlg, opts) {
  const { name, size } = opts;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  if (reading) reading.abort();                          // the file before this one, still coming
  const mine = new AbortController();
  reading = mine;
  const pic = ATARI_PIC.test(name) || WEB_PIC.test(name);
  dlg.innerHTML = `<div class="fm-view-head">
      <h2 class="mono">${esc(name)}</h2>
      <span class="hint mono" data-v="info"></span>
      <span class="fm-view-tools">
        <span class="segmented" data-v="modes" hidden></span>
        <button type="button" class="btn btn-secondary" data-v="edit" hidden>Edit</button>
        <button type="button" class="btn btn-primary" data-v="save" hidden>Save</button>
        <button type="button" class="btn btn-secondary" data-v="discard" hidden>Cancel edit</button>
        <button type="button" class="btn btn-secondary" data-v="prev" title="Previous file (←)">‹</button>
        <button type="button" class="btn btn-secondary" data-v="next" title="Next file (→)">›</button>
        <a class="btn btn-secondary" data-v="dl" href="${esc(opts.downloadUrl)}" download="${esc(name)}">Download</a>
        <button type="button" class="btn btn-primary" data-v="close">Close</button>
      </span>
    </div>
    <p class="fm-view-msg" data-v="msg" role="status" aria-live="polite"></p>
    <div class="fm-view-body" data-v="body">
      <div class="fm-view-read" data-v="read">
        <p class="mono" data-v="readtext" role="status" aria-live="polite">Reading…</p>
        <div class="fm-bar wait" data-v="readbar" role="progressbar" aria-label="Reading the file" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      </div>
    </div>`;
  if (!dlg.open) dlg.showModal();
  const $v = (k) => dlg.querySelector(`[data-v="${k}"]`);
  $v('close').focus();
  const body = $v('body');
  const info = $v('info');
  const modesEl = $v('modes');
  const msg = (t, bad = false) => { $v('msg').textContent = t; $v('msg').classList.toggle('error', bad); };

  // editing state: the editor's text against what it started from
  let editing = null;              // { mode, start, el }
  const dirty = () => editing && editing.el.value !== editing.start;
  const leave = () => !dirty() || window.confirm('Discard your changes?');
  $v('close').onclick = () => { if (leave()) dlg.close(); };
  dlg.oncancel = (e) => { if (!leave()) e.preventDefault(); };          // Esc
  $v('prev').onclick = () => { if (leave() && opts.onPrev) opts.onPrev(); };
  $v('next').onclick = () => { if (leave() && opts.onNext) opts.onNext(); };
  dlg.onkeydown = (e) => {
    if (editing) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      return;                                            // arrows move the caret
    }
    if (e.key === 'ArrowLeft' && opts.onPrev) { e.preventDefault(); opts.onPrev(); }
    if (e.key === 'ArrowRight' && opts.onNext) { e.preventDefault(); opts.onNext(); }
    // up/down and the page keys scroll the file (not the page behind), wherever the focus is
    if (e.target.closest('select, input, textarea')) return;
    const page = Math.max(40, body.clientHeight - 40);
    const by = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page }[e.key];
    if (by) { e.preventDefault(); body.scrollBy(0, by); }
    if (e.key === 'Home') { e.preventDefault(); body.scrollTop = 0; }
    if (e.key === 'End') { e.preventDefault(); body.scrollTop = body.scrollHeight; }
  };
  dlg.addEventListener('close', () => mine.abort(), { once: true });

  const max = pic ? IMG_MAX : TEXT_MAX;
  const expect = Math.min(size, max);
  let bytes;
  try {
    bytes = await readBytes(opts.url(max), expect, mine.signal, (got, of) => {
      if (reading !== mine) return;
      const bar = $v('readbar');
      if (!bar) return;
      const pct = of > 0 ? Math.min(100, Math.round((got * 100) / of)) : 100;
      bar.classList.remove('wait');
      bar.setAttribute('aria-valuenow', pct);
      bar.firstElementChild.style.width = `${pct}%`;
      $v('readtext').textContent = `Reading… ${kb(got)} of ${kb(Math.max(of, got))}`;
    });
  } catch (e) {
    if (reading !== mine || mine.signal.aborted) return;   // closed, or another file opened meanwhile
    reading = null;
    body.innerHTML = `<p class="fm-error">${esc(e.message)}</p>`;
    return;
  }
  if (reading !== mine || mine.signal.aborted) return;
  reading = null;
  const whole = bytes.length >= size;
  const cut = whole ? '' : ` · the first ${Math.round(bytes.length / 1024)} KB of ${Math.round(size / 1024)} KB`;
  let lines = lineMode(bytes);

  const atari = ATARI_PIC.test(name) ? decodeAtariPicture(name, bytes) : null;
  const webPic = WEB_PIC.test(name) && whole;
  const modes = [...(atari || webPic ? ['picture'] : []), 'text', 'hex'];
  let mode = atari || webPic ? 'picture' : looksText(bytes) ? 'text' : 'hex';

  const editBtn = $v('edit');
  const canEdit = !!opts.save && whole && size <= EDIT_MAX;
  editBtn.title = !opts.save ? (opts.readOnly || 'This place is read-only.') : !canEdit ? `Only files up to ${EDIT_MAX / 1024} KB can be edited here.` : 'Edit (Ctrl+S saves)';

  function show() {
    for (const b of modesEl.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    editBtn.hidden = !!editing || mode === 'picture';
    editBtn.disabled = !canEdit;
    $v('save').hidden = !editing;
    $v('discard').hidden = !editing;
    if (mode === 'picture' && atari) {
      const c = document.createElement('canvas');
      c.width = atari.w;
      c.height = atari.h;
      c.getContext('2d').putImageData(new ImageData(atari.px, atari.w, atari.h), 0, 0);
      c.className = 'fm-view-pic';
      c.style.aspectRatio = `${atari.w * atari.sx} / ${atari.h * atari.sy}`;
      c.style.width = `min(100%, ${atari.w * atari.sx}px)`;
      body.replaceChildren(c);
      info.textContent = `${atari.w}×${atari.h}, ${atari.w === 320 ? 'low' : atari.h === 200 ? 'medium' : 'high'} resolution`;
      return;
    }
    if (mode === 'picture') {
      if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([bytes], { type: MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream' }));
      const img = new Image();
      img.className = 'fm-view-pic';
      img.alt = name;
      img.onload = () => { info.textContent = `${img.naturalWidth}×${img.naturalHeight}`; };
      img.onerror = () => { body.innerHTML = '<p class="fm-error">The browser can\'t show this picture.</p>'; };
      img.src = blobUrl;
      body.replaceChildren(img);
      return;
    }
    const lineNote = lines === 'crlf' ? ', CR LF line ends' : lines === 'raw' ? ', CR shown as ␍' : '';
    if (editing) {
      info.textContent = `editing ${mode === 'hex' ? 'hex: pairs of digits, 16 a line (bytes can be added or removed)' : `text (Atari character set${lineNote})`}`;
      return;
    }
    const pre = document.createElement('pre');
    pre.className = 'fm-view-text mono';
    pre.textContent = mode === 'hex' ? hexDump(bytes) : atariText(bytes, lines);
    body.replaceChildren(pre);
    info.textContent = `${mode === 'hex' ? 'hex' : `text (Atari character set${lineNote})`}${cut}`;
  }

  function startEdit() {
    if (!canEdit || editing) return;
    const ta = document.createElement('textarea');
    ta.className = `fm-view-edit mono${mode === 'hex' ? ' hex' : ''}`;
    ta.spellcheck = false;
    ta.value = mode === 'hex' ? hexLines(bytes) : atariText(bytes, lines);
    ta.setAttribute('aria-label', `Edit ${name}`);
    editing = { mode, start: ta.value, el: ta };
    body.replaceChildren(ta);
    modesEl.hidden = true;
    msg('');
    show();
    ta.focus();
  }

  function stopEdit() {
    editing = null;
    modesEl.hidden = modes.length < 2;
    show();
  }

  async function save() {
    if (!editing) return;
    let out;
    try {
      out = editing.mode === 'hex' ? parseHex(editing.el.value) : atariBytes(editing.el.value, lines);
    } catch (e) { msg(e.message, true); return; }
    $v('save').disabled = true;
    msg('Saving…');
    try {
      await opts.save(out);
      bytes = out;
      if (editing.mode === 'hex') lines = lineMode(bytes);
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      msg(`Saved: ${out.length.toLocaleString()} bytes.`);
      stopEdit();
    } catch (e) {
      msg(`Not saved: ${e.message}`, true);
    } finally {
      $v('save').disabled = false;
    }
  }

  modesEl.innerHTML = modes.map((m) => `<button type="button" aria-pressed="false" data-mode="${m}">${m[0].toUpperCase()}${m.slice(1)}</button>`).join('');
  modesEl.hidden = modes.length < 2;
  modesEl.onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b && !editing) { mode = b.dataset.mode; show(); } };
  editBtn.onclick = startEdit;
  $v('save').onclick = save;
  $v('discard').onclick = () => { if (leave()) { stopEdit(); msg(''); } };
  show();
}
