// Files: two panes as Midnight Commander. Each pane shows a folder in one of
// the CosmosEx's places: /storage, a translated drive folder, a USB drive,
// the shared drive, or a hard disk image, whose partitions are shown as
// folders at its top (".." in a partition goes back to them). Keys as in mc (and
// the button bar): Tab switches pane, Enter opens (a file: the viewer),
// Backspace goes up, Insert/Space selects, F2 rename, F3 view, F4 upload,
// F5 copy and F6 move to the other pane, F7 new folder, F8 delete, F9
// download (several: one zip); the digits 2-9 do the same (browsers keep
// some F keys). Files dragged from the computer onto a pane are uploaded
// into its folder (folders with what's in them); rows dragged onto the other
// pane are copied (Shift: moved). A copy or move runs on the CosmosEx as a
// job (one at a time; progress polled, it goes on if the page is left).
//   GET  /api/v1/files/places | list?place=&dir= | read?place=&file= | zip?place=&dir=&name=…
//   POST /api/v1/files/write?place=&dir=&name=[&overwrite=1] (the file) | mkdir | delete | rename (JSON)
//   POST /api/v1/files/conflicts | copy (JSON); GET /api/v1/files/job; POST /api/v1/files/job/cancel
//   GET  /api/v1/settings/hddimage/inspect?path=   an image's partitions
// The panes are kept in the address (#/files?l=<place>|<dir>&r=…), without
// reloading the page (history.replaceState).

import { showViewer } from './files-view.js';

const API = '/api/v1/files';
const INSPECT = '/api/v1/settings/hddimage/inspect';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const narrow = window.matchMedia('(max-width: 759px)');

let root = null;
let st = null;
let keyHandler = null;

/* ------------------------------------------------------------------ api */

async function api(url, opts = {}) {
  let r;
  try {
    r = await fetch(url, { cache: 'no-store', ...opts });
  } catch (e) {
    await new Promise((res) => setTimeout(res, 300));
    r = await fetch(url, { cache: 'no-store', ...opts });
  }
  let d = null;
  try { d = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const err = new Error((d && d.error) || `HTTP ${r.status}`);
    err.status = r.status;
    err.exists = d && d.exists;
    throw err;
  }
  return d;
}

const post = (what, body) => api(`${API}/${what}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// one file; resolves {name}, rejects with .status/.exists; .abort() stops it
// (each step logged to the browser's console: "files: …")
function putFile(place, dir, name, file, overwrite, onProgress, onSent) {
  const xhr = new XMLHttpRequest();
  const t0 = Date.now();
  const note = (what) => console.info(`files: ${name}: ${what} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const p = new Promise((resolve, reject) => {
    xhr.open('POST', `${API}/write?${qs({ place, dir, name, ...(overwrite ? { overwrite: 1 } : {}) })}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    xhr.upload.onload = () => { note('sent, waiting for the CosmosEx'); if (onSent) onSent(); };
    xhr.upload.onerror = () => note('sending failed');
    let finished = false;
    // Safari (seen with 100 MB) can stay at readyState 3 with the whole answer
    // there and never fire load: done once the body has its Content-Length
    xhr.onreadystatechange = () => {
      note(`readyState ${xhr.readyState}, HTTP ${xhr.status}`);
      if (xhr.readyState !== 3 || finished) return;
      const len = Number(xhr.getResponseHeader('Content-Length'));
      if (len > 0 && new TextEncoder().encode(xhr.responseText).length === len) { note('answer complete (before load)'); xhr.onload(); }
    };
    xhr.onload = () => {
      if (finished) return;
      finished = true;
      note(`answer ${xhr.status}`);
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      if (xhr.status === 200) { resolve(d || {}); return; }
      const err = new Error((d && d.error) || `HTTP ${xhr.status}`);
      err.status = xhr.status;
      err.exists = d && d.exists;
      reject(err);
    };
    xhr.onerror = () => { if (finished) return; finished = true; note('connection lost'); reject(new Error('The connection was lost.')); };
    xhr.onabort = () => { if (finished) return; finished = true; const e = new Error('Cancelled.'); e.cancelled = true; reject(e); };
    xhr.send(file);
  });
  p.abort = () => xhr.abort();
  return p;
}

/* ---------------------------------------------------------------- state */

const newPane = () => ({
  place: '', dir: '/', image: '', parts: null, items: [], cursor: 0, sel: new Set(),
  info: {}, loading: false, error: '',
});

function fromHash() {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  return ['l', 'r'].map((k) => {
    const v = q.get(k);
    if (!v) return null;
    const i = v.lastIndexOf('|');
    return i < 0 ? { place: v, dir: '/' } : { place: v.slice(0, i), dir: v.slice(i + 1) || '/' };
  });
}

function toHash() {
  const spec = (p) => (p.place ? `${p.place}|${p.dir}` : p.image ? `image:${p.image}` : '');
  const q = st.panes.map((p, i) => (spec(p) ? `${i ? 'r' : 'l'}=${encodeURIComponent(spec(p))}` : '')).filter(Boolean).join('&');
  history.replaceState(null, '', `#/files${q ? `?${q}` : ''}`);
}

const imageOf = (place) => (place.startsWith('img:') ? place.slice(place.indexOf(':', 4) + 1) : '');
const partOf = (place) => (place.startsWith('img:') ? place.slice(4, place.indexOf(':', 4)) : '');

/* ---------------------------------------------------------------- mount */

export function mount(el) {
  root = el;
  st = { places: [], images: [], panes: [newPane(), newPane()], active: 0, msg: '', msgBad: false, busy: false, upload: null };
  el.innerHTML = `
    <header class="page-head">
      <div>
        <p class="eyebrow">Two panes · keys as in mc</p>
        <h1>Files</h1>
        <p class="page-hint">Files on the CosmosEx's drives and inside hard disk images. Drag files from your computer onto a pane to upload them, or rows onto the other pane to copy them (Shift: move). Keys: <span class="mono">Tab</span> other pane, <span class="mono">Enter</span> open (a hard disk image: go inside, <span class="mono">..</span> leads back out), <span class="mono">Backspace</span> up, <span class="mono">Insert</span>/<span class="mono">Space</span> select, <span class="mono">2</span>–<span class="mono">9</span> or <span class="mono">F2</span>–<span class="mono">F9</span> as in the bar below.</p>
      </div>
    </header>
    <div class="segmented fm-switch" role="radiogroup" aria-label="Pane" data-fm="switch">
      <button type="button" role="radio" aria-checked="true" data-pane-show="0">Left</button>
      <button type="button" role="radio" aria-checked="false" data-pane-show="1">Right</button>
    </div>
    <div class="fm" data-fm="panes" data-noswipe>
      ${[0, 1].map((i) => `<section class="fm-pane" data-pane="${i}" aria-label="${i ? 'Right' : 'Left'} pane">
        <div class="fm-head">
          <select class="select fm-place" data-place="${i}" aria-label="Place (${i ? 'right' : 'left'})"><option>Loading…</option></select>
        </div>
        <p class="fm-path mono" data-path="${i}"></p>
        <div class="fm-list" data-list="${i}" role="listbox" aria-multiselectable="true" tabindex="0" aria-label="Files (${i ? 'right' : 'left'})"></div>
        <p class="fm-foot mono" data-foot="${i}"></p>
        <div class="fm-drop" data-drop="${i}" hidden><span>Drop to upload here</span></div>
      </section>`).join('')}
    </div>
    <p class="fm-msg" data-fm="msg" role="status" aria-live="polite"></p>
    <div class="fm-progress" data-fm="progress" hidden>
      <div class="fm-progress-text mono" data-fm="ptext"></div>
      <div class="fm-bar"><span data-fm="pbar"></span></div>
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
    </div>
    <nav class="fm-keys" aria-label="Commands">
      <button type="button" class="btn btn-secondary" data-act="rename"><b>2</b> Rename</button>
      <button type="button" class="btn btn-secondary" data-act="view"><b>3</b> View</button>
      <button type="button" class="btn btn-secondary" data-act="upload"><b>4</b> Upload</button>
      <button type="button" class="btn btn-secondary" data-act="copy"><b>5</b> Copy</button>
      <button type="button" class="btn btn-secondary" data-act="move"><b>6</b> Move</button>
      <button type="button" class="btn btn-secondary" data-act="mkdir"><b>7</b> Folder</button>
      <button type="button" class="btn btn-secondary" data-act="delete"><b>8</b> Delete</button>
      <button type="button" class="btn btn-secondary" data-act="download"><b>9</b> Download</button>
      <button type="button" class="btn btn-secondary" data-act="swap"><b>Tab</b> Other pane</button>
    </nav>
    <input type="file" multiple hidden data-fm="file">
    <dialog class="fm-dlg" data-fm="dlg"></dialog>
    <dialog class="fm-view" data-fm="view" aria-label="File viewer"></dialog>`;

  el.addEventListener('click', onClick);
  el.addEventListener('dblclick', onDblClick);
  el.addEventListener('change', onChange);
  for (const pane of el.querySelectorAll('[data-pane]')) setupDrop(pane);
  keyHandler = onKey;
  document.addEventListener('keydown', keyHandler);
  narrow.addEventListener('change', showActive);
  init();
}

export function unmount() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  narrow.removeEventListener('change', showActive);
  if (st && st.upload) st.upload.cancel();
  if (st && st.jobTimer) clearTimeout(st.jobTimer);        // (the job itself goes on)
  keyHandler = null;
  root = null;
}

const $ = (sel) => root.querySelector(sel);
const paneEl = (i) => root.querySelector(`[data-pane="${i}"]`);

function say(msg, bad = false) {
  st.msg = msg;
  st.msgBad = bad;
  const p = root && $('[data-fm="msg"]');
  if (p) { p.textContent = msg; p.classList.toggle('error', bad); }
}

async function init() {
  const want = fromHash();
  await loadPlaces();
  if (!root) return;
  for (const i of [0, 1]) {
    const w = want[i];
    const fallback = i === 0 ? (st.places.find((p) => p.kind === 'translated') || st.places[0]) : (st.places.find((p) => p.kind === 'usb') || st.places[0]);
    if (w && w.place.startsWith('image:')) await chooseImage(i, w.place.slice(6));
    else if (w) { st.panes[i].place = w.place; st.panes[i].dir = w.dir; st.panes[i].image = imageOf(w.place); if (st.panes[i].image) await loadParts(i); }
    else if (fallback) st.panes[i].place = fallback.id;
  }
  if (!root) return;
  renderPlaces();
  await Promise.all([load(0), load(1)]);
  setActive(0);
  try { const j = await api(`${API}/job`); if (root && j.state === 'running') watchJob(); } catch (e) { /* none */ }
}

async function loadPlaces() {
  try {
    const d = await api(`${API}/places`);
    st.places = d.places || [];
    st.images = d.images || [];
  } catch (e) {
    say(`Couldn't list the drives: ${e.message}`, true);
  }
}

/* ------------------------------------------------------------- places */

function placeOptions(i) {
  const p = st.panes[i];
  const group = (label, items) => (items.length ? `<optgroup label="${esc(label)}">${items.join('')}</optgroup>` : '');
  const opt = (value, label) => `<option value="${esc(value)}"${(p.image ? `image:${p.image}` : p.place) === value ? ' selected' : ''}>${esc(label)}</option>`;
  const kind = (k) => st.places.filter((x) => x.kind === k).map((x) => opt(x.id, x.label));
  let html = group('Translated drives', kind('translated')) + group('USB drives', kind('usb')) + group('Shared drive', kind('shared'))
    + group('Hard disk images', st.images.map((x) => opt(`image:${x.path}`, `${x.name}${x.path.startsWith('/mnt/') ? ' (USB)' : ''}`)))
    + group('This CosmosEx', kind('storage'));
  const known = st.places.some((x) => x.id === p.place) || p.image;
  if (p.place && !known) html = opt(p.place, `${p.place} (not there)`) + html;
  return html;
}

function renderPlaces() {
  for (const i of [0, 1]) {
    const p = st.panes[i];
    const sel = root.querySelector(`[data-place="${i}"]`);
    sel.innerHTML = placeOptions(i) || '<option value="">No drives</option>';
  }
}

async function loadParts(i) {
  const p = st.panes[i];
  try {
    const d = await api(`${INSPECT}?${qs({ path: p.image })}`);
    p.parts = (d.parts || []).map((x) => ({ ...x, readable: !!x.type }));
    p.swapped = !!d.swapped;
  } catch (e) {
    p.parts = [];
    p.error = e.message;
  }
}

async function chooseImage(i, path) {
  const p = st.panes[i];
  Object.assign(p, { image: path, parts: null, place: '', dir: '/', error: '' });
  await loadParts(i);
  if (!p.error && !(p.parts || []).some((x) => x.readable)) p.error = 'No partition in this image can be read here.';
}

// Where an image file lies, as a place and folder of the Files page (the
// images that can be opened are those of <storage>/hdd_images and of the top
// folder of USB drives), or null.
function imageHome(path) {
  const seg = path.split('/');
  const name = seg.pop();
  const folder = seg.pop();
  if (path.startsWith('/mnt/')) {
    const usb = st.places.find((x) => x.id === `usb:${folder}`);
    return usb ? { place: usb.id, dir: '/', name } : null;
  }
  const storage = st.places.find((x) => x.kind === 'storage');
  return storage && folder === 'hdd_images' ? { place: storage.id, dir: '/hdd_images', name } : null;
}

// the image that the file <name> of a pane's folder is, if it's one that can be opened
function imageAt(p, name) {
  return st.images.find((x) => {
    const h = x.name === name && imageHome(x.path);
    return h && h.place === p.place && h.dir === p.dir;
  });
}

const IMAGE_EXT = /\.(img|hd|hdd|ima|raw)$/i;

// Enter on an image file: into it, in place (.. at its top leads back here)
async function enterImage(i, name) {
  const p = st.panes[i];
  let img = imageAt(p, name);
  if (!img && IMAGE_EXT.test(name)) {          // perhaps new since the page was loaded
    await loadPlaces();
    if (!root) return false;
    img = imageAt(p, name);
  }
  if (!img) return false;
  await chooseImage(i, img.path);
  if (!root) return true;
  p.sel.clear();
  p.cursor = 0;
  renderPlaces();
  load(i);
  return true;
}

/* ---------------------------------------------------------------- list */

// an image's top: its partitions as folders
function listParts(i, keepName) {
  const p = st.panes[i];
  p.items = (imageHome(p.image) ? [{ name: '..', type: 'up' }] : []).concat((p.parts || []).map((x) => ({
    type: x.readable ? 'part' : 'other', n: x.n, size: x.sizeMB * 1048576,
    name: `${x.n ? `Partition ${x.n}` : 'Whole image'}${x.label && x.type ? ` · ${x.label}` : ''}`, fs: x.type || (x.label ? `not readable: ${x.label}` : 'not readable here'),
  })));
  p.info = {};
  p.sel.clear();
  const at = keepName != null ? p.items.findIndex((x) => x.n === keepName) : -1;
  p.cursor = at >= 0 ? at : 0;
  p.loading = false;
  renderPane(i);
  toHash();
}

async function load(i, keepName) {
  const p = st.panes[i];
  // an answer that comes after the pane has gone elsewhere (a slow image, quick keys) is dropped
  const turn = p.turn = (p.turn || 0) + 1;
  if (p.image && !p.place) { listParts(i, keepName); return; }
  if (!p.place) { p.items = []; renderPane(i); return; }
  p.loading = true;
  renderPane(i);
  try {
    const d = await api(`${API}/list?${qs({ place: p.place, dir: p.dir })}`);
    if (!root || p.turn !== turn) return;
    const entries = (d.entries || []).sort((a, b) => (b.type === 'folder') - (a.type === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    p.items = (p.dir !== '/' || p.image ? [{ name: '..', type: 'up' }] : []).concat(entries);
    p.info = { writable: d.writable, names83: d.names83, freeKB: d.freeKB, more: d.more, readOnly: d.readOnly };
    p.error = '';
    p.sel = new Set([...p.sel].filter((n) => entries.some((x) => x.name === n)));
    const at = keepName ? p.items.findIndex((x) => x.name === keepName) : -1;
    p.cursor = at >= 0 ? at : Math.min(p.cursor, Math.max(0, p.items.length - 1));
  } catch (e) {
    if (!root || p.turn !== turn) return;
    p.items = p.dir !== '/' || p.image ? [{ name: '..', type: 'up' }] : [];
    p.info = {};
    p.error = e.message;
    p.cursor = 0;
  }
  p.loading = false;
  renderPane(i);
  toHash();
}

// why a place is read-only (an image partition: ce-hdinspect's reason)
const RO = {
  attached: ['read-only: attached to an ID', 'This image is attached to an ID: detach it on the Hard disk page to change files.'],
  experimental: ['read-only: big sectors / swapped (Config → Experimental)', 'Writing to big Atari partitions and byte-swapped images is experimental: switch it on in Config → Experimental (keep a copy of the image).'],
  rootfill: ['read-only: the root folder doesn\'t fill its sectors', 'This partition\'s root folder doesn\'t fill its sectors: it can only be read here.'],
  file: ['read-only: the image file', 'The image file itself is read-only.'],
};
const roShort = (p) => (p.image ? (RO[p.info.readOnly] || RO.attached)[0] : 'read-only');
const roLong = (p) => (p.image ? (RO[p.info.readOnly] || RO.attached)[1] : 'This place is read-only.');

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 10240 ? `${Math.round(n / 1024)} KB` : `${n}`);
const fmtDate = (t) => (t > 0 ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '');
const fmtKB = (kb) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);

function renderPane(i) {
  if (!root) return;
  const p = st.panes[i];
  const list = root.querySelector(`[data-list="${i}"]`);
  const imgName = p.image ? p.image.split('/').pop() : '';
  const partName = p.place && p.image ? (partOf(p.place) === '0' ? 'Whole image' : `Partition ${partOf(p.place)}`) : '';
  root.querySelector(`[data-path="${i}"]`).textContent = p.image ? `${imgName}/${partName ? `${partName}${p.dir === '/' ? '' : p.dir}` : ''}` : p.place ? `${p.dir}${p.loading ? '  …' : ''}` : '';
  if (p.error && !p.items.length) {
    list.innerHTML = `<p class="fm-error">${esc(p.error)}</p>`;
  } else {
    list.innerHTML = (p.error ? `<p class="fm-error">${esc(p.error)}</p>` : '') + p.items.map((x, n) => `<div class="fm-row${n === p.cursor ? ' cur' : ''}${p.sel.has(x.name) ? ' sel' : ''} fm-${x.type}" role="option" aria-selected="${p.sel.has(x.name)}" data-i="${n}"${x.type === 'file' || x.type === 'folder' ? ' draggable="true"' : ''}>
        <span class="fm-name">${x.type === 'up' ? '..' : esc(x.name)}${x.type === 'folder' || x.type === 'part' ? '/' : x.type === 'link' ? ' →' : ''}</span>
        <span class="fm-size mono">${x.type === 'folder' ? '&lt;DIR&gt;' : x.type === 'file' || x.fs ? esc(fmtSize(x.size)) : x.type === 'up' ? 'UP' : ''}</span>
        <span class="fm-date mono">${x.fs ? esc(x.fs) : x.mtime ? esc(fmtDate(x.mtime)) : ''}</span>
      </div>`).join('') + (p.info.more ? '<p class="hint">Only the first 5000 entries are shown.</p>' : '');
  }
  renderFoot(i);
  scrollToCursor(i);
}

function renderFoot(i) {
  const p = st.panes[i];
  if (p.image && !p.place) {
    const n = p.items.filter((x) => x.type !== 'up').length;
    root.querySelector(`[data-foot="${i}"]`).textContent = `${n} partition${n === 1 ? '' : 's'}${p.swapped ? ' · byte-swapped image (swapped back as it\'s read)' : ''}${p.items.some((x) => x.type === 'other') ? ' · some can\'t be read here' : ''}`;
    return;
  }
  const files = p.items.filter((x) => x.type !== 'up');
  const selBytes = files.filter((x) => p.sel.has(x.name)).reduce((a, x) => a + (x.size || 0), 0);
  const parts = [`${files.length} item${files.length === 1 ? '' : 's'}`];
  if (p.sel.size) parts.push(`${p.sel.size} selected (${fmtSize(selBytes)})`);
  if (p.info.freeKB != null) parts.push(`${fmtKB(p.info.freeKB)} free`);
  if (p.info.writable === false) parts.push(roShort(p));
  if (p.info.names83) parts.push('8.3 names');
  root.querySelector(`[data-foot="${i}"]`).textContent = parts.join(' · ');
}

function scrollToCursor(i) {
  const row = root.querySelector(`[data-list="${i}"] [data-i="${st.panes[i].cursor}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function moveCursor(i, to) {
  const p = st.panes[i];
  if (!p.items.length) return;
  const n = Math.max(0, Math.min(p.items.length - 1, to));
  const list = root.querySelector(`[data-list="${i}"]`);
  const old = list.querySelector(`[data-i="${p.cursor}"]`);
  if (old) old.classList.remove('cur');
  p.cursor = n;
  const row = list.querySelector(`[data-i="${n}"]`);
  if (row) { row.classList.add('cur'); row.scrollIntoView({ block: 'nearest' }); }
}

function toggleSel(i, n, on) {
  const p = st.panes[i];
  const x = p.items[n];
  if (!x || x.type === 'up' || x.type === 'part' || (p.image && !p.place)) return;
  const want = on ?? !p.sel.has(x.name);
  if (want) p.sel.add(x.name); else p.sel.delete(x.name);
  const row = root.querySelector(`[data-list="${i}"] [data-i="${n}"]`);
  if (row) { row.classList.toggle('sel', want); row.setAttribute('aria-selected', want); }
  renderFoot(i);
}

function setActive(i) {
  st.active = i;
  for (const n of [0, 1]) paneEl(n).classList.toggle('active', n === i);
  showActive();
}

// the keyboard focus on a pane's list (without moving the page)
function focusList(i = st.active) {
  const list = root && root.querySelector(`[data-list="${i}"]`);
  if (list) list.focus({ preventScroll: true });
}

function showActive() {
  if (!root) return;
  for (const n of [0, 1]) paneEl(n).classList.toggle('shown', n === st.active);
  for (const b of root.querySelectorAll('[data-pane-show]')) b.setAttribute('aria-checked', String(Number(b.dataset.paneShow) === st.active));
}

const rowsPerPage = (i) => {
  const list = root.querySelector(`[data-list="${i}"]`);
  const row = list.querySelector('.fm-row');
  return row ? Math.max(1, Math.floor(list.clientHeight / row.offsetHeight) - 1) : 10;
};

// what a command works on: the selection, or else the entry at the cursor
function targets(i) {
  const p = st.panes[i];
  if (p.sel.size) return p.items.filter((x) => p.sel.has(x.name));
  const x = p.items[p.cursor];
  return x && x.type !== 'up' && x.type !== 'part' && p.place ? [x] : [];
}

const childDir = (dir, name) => `${dir.replace(/\/$/, '')}/${name}`;
const parentDir = (dir) => dir.replace(/\/[^/]*\/?$/, '') || '/';

function open(i) {
  const p = st.panes[i];
  const x = p.items[p.cursor];
  if (!x) return;
  if (x.type === 'up') { up(i); return; }
  if (x.type === 'part') { p.place = `img:${x.n}:${p.image}`; p.dir = '/'; p.sel.clear(); p.cursor = 0; load(i); return; }
  if (x.type === 'folder') { p.dir = childDir(p.dir, x.name); p.sel.clear(); p.cursor = 0; load(i); return; }
  if (x.type === 'file') {
    // a hard disk image: into it; any other file (or an image that can't be opened here): the viewer
    enterImage(i, x.name).then((entered) => { if (!entered && root && st.panes[i].items[st.panes[i].cursor] === x) viewCmd(i); });
  }
}

function up(i) {
  const p = st.panes[i];
  if (p.image && p.place && p.dir === '/') {         // a partition's root: back to the partitions
    const n = Number(partOf(p.place));
    p.place = '';
    load(i, n);
    return;
  }
  if (p.image && !p.place) {                         // an image's top: back to the folder the image is in
    const home = imageHome(p.image);
    if (!home) return;
    Object.assign(p, { image: '', parts: null, place: home.place, dir: home.dir, error: '' });
    p.sel.clear();
    renderPlaces();
    load(i, home.name);
    return;
  }
  if (p.dir === '/') return;
  const from = p.dir.split('/').pop();
  p.dir = parentDir(p.dir);
  p.sel.clear();
  load(i, from);
}

/* ------------------------------------------------------------- dialogs */

// a small modal: {title, text, input, value, buttons: [[value, label, primary]]} -> the button's value (or the input)
function ask({ title, text = '', input = false, value = '', buttons }) {
  const dlg = $('[data-fm="dlg"]');
  dlg.innerHTML = `<form method="dialog" class="fm-dlg-form">
      <h2>${esc(title)}</h2>
      ${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input class="input mono" data-dlg-input value="${esc(value)}" autocomplete="off" spellcheck="false">` : ''}
      <div class="fm-dlg-buttons">${buttons.map(([v, l, primary]) => `<button type="submit" class="btn ${primary ? 'btn-primary' : 'btn-secondary'}" value="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const v = dlg.returnValue;
      const inp = dlg.querySelector('[data-dlg-input]');
      resolve(v === '' || v === 'cancel' ? null : input && v === 'ok' ? inp.value.trim() : v);
      focusList();
    };
    dlg.returnValue = '';
    dlg.showModal();
    const inp = dlg.querySelector('[data-dlg-input]');
    if (inp) {
      inp.focus();
      const dot = inp.value.lastIndexOf('.');
      inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); } });
    }
  });
}

const dlgOpen = () => root && ($('[data-fm="dlg"]').open || $('[data-fm="view"]').open);

/* ------------------------------------------------------------ commands */

// a change here refused at once, with the reason, instead of after asking
function readOnlySaid(p) {
  if (p.info.writable !== false) return false;
  say(roLong(p), true);
  return true;
}

async function mkdirCmd(i) {
  const p = st.panes[i];
  if (!p.place || readOnlySaid(p)) return;
  const name = await ask({ title: 'New folder', text: p.info.names83 ? 'GEMDOS partition: the name becomes 8.3 in capitals.' : '', input: true, buttons: [['ok', 'Make it', true], ['cancel', 'Cancel']] });
  if (!name) return;
  try {
    const r = await post('mkdir', { place: p.place, dir: p.dir, name });
    say(`Folder ${r.name} made.`);
    await load(i, r.name);
  } catch (e) { say(e.message, true); }
}

async function renameCmd(i) {
  const p = st.panes[i];
  if (readOnlySaid(p)) return;
  const x = p.items[p.cursor];
  if (!x || x.type === 'up') return;
  const to = await ask({ title: `Rename ${x.name}`, input: true, value: x.name, buttons: [['ok', 'Rename', true], ['cancel', 'Cancel']] });
  if (!to || to === x.name) return;
  try {
    const r = await post('rename', { place: p.place, dir: p.dir, from: x.name, to });
    p.sel.delete(x.name);
    say(`${x.name} is now ${r.name}.`);
    await load(i, r.name);
  } catch (e) { say(e.message, true); }
}

async function deleteCmd(i) {
  const p = st.panes[i];
  if (readOnlySaid(p)) return;
  const t = targets(i);
  if (!t.length) return;
  const folders = t.filter((x) => x.type === 'folder').length;
  const what = t.length === 1 ? `${t[0].name}${t[0].type === 'folder' ? ' and everything in it' : ''}` : `${t.length} items${folders ? ` (${folders} folder${folders === 1 ? '' : 's'} with everything in them)` : ''}`;
  const ok = await ask({ title: 'Delete', text: `Delete ${what}? This can't be undone.`, buttons: [['yes', 'Delete', true], ['cancel', 'Cancel']] });
  if (ok !== 'yes') return;
  try {
    const r = await post('delete', { place: p.place, dir: p.dir, names: t.map((x) => x.name) });
    p.sel.clear();
    say(`${r.deleted} deleted.`);
  } catch (e) { say(e.message, true); }
  await load(i);
}

function download(i) {
  const p = st.panes[i];
  const t = targets(i);
  if (!t.length || !p.place) return;
  const one = t.length === 1 && t[0].type === 'file';
  const url = one ? `${API}/read?${qs({ place: p.place, file: childDir(p.dir, t[0].name) })}`
    : `${API}/zip?${qs({ place: p.place, dir: p.dir })}&${t.map((x) => `name=${encodeURIComponent(x.name)}`).join('&')}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = one ? t[0].name : (t.length === 1 ? `${t[0].name}.zip` : 'files.zip');
  document.body.appendChild(a);
  a.click();
  a.remove();
  say(one ? `Downloading ${t[0].name}.` : `Downloading ${t.length === 1 ? t[0].name : `${t.length} items`} as a zip.`);
}

/* --------------------------------------------------------- copy, move */

const where = (p) => `${p.image ? `${p.image.split('/').pop()}: ` : ''}${p.dir}`;

// copy (or move) the selection, or the names given (dragged), from pane i to the other pane
async function transfer(i, op, names) {
  const src = st.panes[i];
  const dst = st.panes[1 - i];
  const t = names ? src.items.filter((x) => names.includes(x.name)) : targets(i);
  if (!t.length) return;
  if (st.job) { say('A copy or move is running: wait for it, or cancel it.', true); return; }
  if (!dst.place) { say(dst.image ? 'Open a partition in the other pane first.' : 'Pick a place in the other pane first.', true); return; }
  if (dst.info.writable === false) { say(`The other pane: ${roLong(dst)}`, true); return; }
  if (op === 'move' && src.info.writable === false) { say(`${roLong(src)} Copy instead.`, true); return; }
  if (src.place === dst.place && src.dir === dst.dir) { say('Both panes show the same folder.', true); return; }
  const verb = op === 'move' ? 'Move' : 'Copy';
  const bytes = t.reduce((a, x) => a + (x.size || 0), 0);
  const folders = t.filter((x) => x.type === 'folder').length;
  const what = t.length === 1 ? t[0].name : `${t.length} items${folders ? ` (${folders} folder${folders === 1 ? '' : 's'})` : ''}`;
  if (!names) {
    const ok = await ask({ title: verb, text: `${verb} ${what}${bytes ? ` (${fmtSize(bytes)}${folders ? ' and the folders\' contents' : ''})` : ''} to ${where(dst)}?${dst.info.names83 ? ' Names become 8.3 there.' : ''}`, buttons: [['ok', verb, true], ['cancel', 'Cancel']] });
    if (ok !== 'ok') return;
  }
  let list = t.map((x) => x.name);
  let replace = false;
  try {
    const c = await post('conflicts', { to: { place: dst.place, dir: dst.dir }, names: list });
    let policy = null;
    for (const x of c.exists) {
      let ans = policy;
      if (!ans) {
        ans = await ask({ title: 'Already there', text: `${x.stored}${x.type === 'folder' ? ' (a folder)' : ''} is already in ${where(dst)}.${x.type === 'folder' ? ' Replace puts both folders together, replacing files with the same names.' : ''}`,
          buttons: [['replace', 'Replace'], ['skip', 'Skip', true], ['replace-all', 'Replace all'], ['skip-all', 'Skip all'], ['cancel', 'Stop']] });
        if (!ans) return;
        if (ans.endsWith('-all')) { ans = ans.slice(0, -4); policy = ans; }
      }
      if (ans === 'skip') list = list.filter((n) => n !== x.name); else replace = true;
    }
    if (!list.length) { say('Nothing to do: everything was skipped.'); return; }
    await post('copy', { op, from: { place: src.place, dir: src.dir }, to: { place: dst.place, dir: dst.dir }, names: list, replace });
  } catch (e) {
    say(e.message, true);
    return;
  }
  src.sel.clear();
  renderFoot(i);
  watchJob();
}

// the job's progress, until it's done
function watchJob() {
  if (!root) return;
  st.job = st.job || { cancelling: false };
  const box = $('[data-fm="progress"]');
  box.hidden = false;
  const poll = async () => {
    if (!root) return;
    let j;
    try { j = await api(`${API}/job`); } catch (e) { st.jobTimer = setTimeout(poll, 1000); return; }
    if (!root) return;
    if (j.state === 'running') {
      const pct = j.totalBytes ? Math.round((j.doneBytes / j.totalBytes) * 100) : 0;
      $('[data-fm="ptext"]').textContent = `${j.op === 'move' ? 'Moving' : 'Copying'}${st.job.cancelling ? ' (cancelling)' : ''}: ${j.doneFiles} of ${j.totalFiles} file${j.totalFiles === 1 ? '' : 's'} · ${fmtSize(j.doneBytes)} of ${fmtSize(j.totalBytes)}${j.current ? ` · ${j.current}` : ''}`;
      $('[data-fm="pbar"]').style.width = `${pct}%`;
      st.jobTimer = setTimeout(poll, 400);
      return;
    }
    st.job = null;
    st.jobTimer = null;
    box.hidden = true;
    const ren = (j.renamed || []).slice(0, 12).map((r) => `${r.from} → ${r.to}`).join(', ');
    say(`${j.message || j.state}${ren ? ` Stored as: ${ren}${j.renamed.length > 12 ? ', …' : ''}.` : ''}`, j.state === 'failed');
    for (const n of [0, 1]) load(n, st.panes[n].items[st.panes[n].cursor] && st.panes[n].items[st.panes[n].cursor].name);
  };
  if (st.jobTimer) clearTimeout(st.jobTimer);
  poll();
}

/* ---------------------------------------------------------------- view */

function viewCmd(i) {
  const p = st.panes[i];
  const x = p.items[p.cursor];
  if (!x || x.type !== 'file' || !p.place) return;
  const file = childDir(p.dir, x.name);
  const step = (d) => {
    for (let n = p.cursor + d; n >= 0 && n < p.items.length; n += d) {
      if (p.items[n].type === 'file') { moveCursor(i, n); viewCmd(i); return; }
    }
  };
  const dlg = $('[data-fm="view"]');
  dlg.onclose = () => focusList(i);                       // back on the list, the keys with it
  showViewer(dlg, {
    name: x.name,
    size: x.size,
    url: (max) => `${API}/read?${qs({ place: p.place, file, max })}`,
    downloadUrl: `${API}/read?${qs({ place: p.place, file })}`,
    onPrev: () => step(-1),
    onNext: () => step(1),
    // edit: the file written back in place (the same name)
    readOnly: p.info.writable === false ? roLong(p) : '',
    save: p.info.writable === false ? null : async (bytes) => {
      await putFile(p.place, p.dir, x.name, new Blob([bytes]), true);
      say(`${x.name} saved.`);
      load(i, x.name);
      for (const n of [0, 1]) if (n !== i && st.panes[n].place === p.place && st.panes[n].dir === p.dir) load(n);
    },
  });
}

/* -------------------------------------------------------------- upload */

// [{file, path: ['SUB', 'DIR']}] from a drop (folders walked) or a file picker
async function filesFromDrop(dt) {
  const out = [];
  const items = [...(dt.items || [])].filter((it) => it.kind === 'file');
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  if (!entries.length || entries.some((e) => !e)) return [...dt.files].map((file) => ({ file, path: [] }));
  const readAll = (reader) => new Promise((resolve) => {
    const all = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, () => resolve(all));
    next();
  });
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (file) out.push({ file, path });
    } else if (entry.isDirectory) {
      out.push({ dir: true, path: [...path, entry.name] });
      for (const e of await readAll(entry.createReader())) await walk(e, [...path, entry.name]);
    }
  };
  for (const e of entries) await walk(e, []);
  return out;
}

async function upload(i, list) {
  const p = st.panes[i];
  if (p.image && !p.place) { say('Open a partition first (Enter): files go inside one.', true); return; }
  if (!p.place || !list.length || st.upload) return;
  if (p.info.writable === false) { say(roLong(p), true); return; }
  const files = list.filter((x) => !x.dir);
  const total = files.reduce((a, x) => a + x.file.size, 0);
  let doneBytes = 0;
  let done = 0;
  let policy = null;               // 'replace' | 'skip' for all after asking
  const renamed = [];
  const dirMap = new Map();        // 'A/B' -> the stored path (names may become 8.3)
  let cancelled = false;
  let current = null;
  st.upload = { cancel: () => { cancelled = true; if (current) current.abort(); } };
  const box = $('[data-fm="progress"]');
  box.hidden = false;
  const show = (name, loaded, writing) => {
    const pct = total ? Math.round(((doneBytes + loaded) / total) * 100) : 100;
    $('[data-fm="ptext"]').textContent = writing ? `Writing ${name} to the card (${done + 1} of ${files.length})…`
      : `Uploading ${done + 1} of ${files.length}: ${name} · ${fmtSize(doneBytes + loaded)} of ${fmtSize(total)}`;
    $('[data-fm="pbar"]').style.width = `${pct}%`;
  };
  const storedDir = async (path) => {
    let dir = p.dir;
    for (let n = 1; n <= path.length; n++) {
      const key = path.slice(0, n).join('/');
      if (!dirMap.has(key)) {
        const parent = n > 1 ? dirMap.get(path.slice(0, n - 1).join('/')) : p.dir;
        let name = path[n - 1];
        try {
          name = (await post('mkdir', { place: p.place, dir: parent, name })).name;
        } catch (e) {
          if (e.status !== 409) throw e;
          name = e.exists || name;                     // already there: use it
        }
        if (name !== path[n - 1]) renamed.push(`${path[n - 1]}/ → ${name}/`);
        dirMap.set(key, childDir(parent, name));
      }
      dir = dirMap.get(key);
    }
    return dir;
  };
  try {
    for (const x of list.filter((y) => y.dir)) { if (cancelled) break; await storedDir(x.path); }
    for (const x of files) {
      if (cancelled) break;
      const dir = x.path.length ? await storedDir(x.path) : p.dir;
      show(x.file.name, 0);
      let r = null;
      try {
        current = putFile(p.place, dir, x.file.name, x.file, policy === 'replace', (l) => show(x.file.name, l), () => show(x.file.name, x.file.size, true));
        r = await current;
      } catch (e) {
        if (e.status !== 409 || !e.exists || policy === 'replace') throw e;
        let what = policy;
        if (!what) {
          what = await ask({ title: 'Already there', text: `${e.exists} is already in ${dir}.`,
            buttons: [['replace', 'Replace'], ['skip', 'Skip', true], ['replace-all', 'Replace all'], ['skip-all', 'Skip all'], ['cancel', 'Stop']] });
          if (!what) { cancelled = true; break; }
          if (what.endsWith('-all')) { what = what.slice(0, -4); policy = what; }
        }
        if (what === 'replace') {
          current = putFile(p.place, dir, x.file.name, x.file, true, (l) => show(x.file.name, l), () => show(x.file.name, x.file.size, true));
          r = await current;
        }
      }
      current = null;
      doneBytes += x.file.size;
      if (r) {
        done++;
        if (r.name && r.name !== x.file.name) renamed.push(`${x.file.name} → ${r.name}`);
      }
    }
    say(`${cancelled ? 'Stopped: ' : ''}${done} file${done === 1 ? '' : 's'} uploaded.${renamed.length ? ` Stored as: ${renamed.slice(0, 12).join(', ')}${renamed.length > 12 ? ', …' : ''}.` : ''}`);
  } catch (e) {
    say(e.cancelled ? `Cancelled after ${done} file${done === 1 ? '' : 's'}.` : `${done ? `${done} uploaded; then: ` : ''}${e.message}`, !e.cancelled);
  } finally {
    st.upload = null;
    if (root) { box.hidden = true; await load(i); for (const n of [0, 1]) if (n !== i && st.panes[n].place === p.place) load(n); }
  }
}

const ROWS = 'application/x-ce-files';
let dragFrom = null;                     // the pane rows are dragged from (dataTransfer is unreadable before the drop)

function setupDrop(pane) {
  const i = Number(pane.dataset.pane);
  const veil = pane.querySelector('[data-drop]');
  let depth = 0;
  const types = (e) => [...(e.dataTransfer?.types || [])];
  const isFiles = (e) => types(e).includes('Files');
  const isRows = (e) => types(e).includes(ROWS) && dragFrom !== null && dragFrom !== i;
  const label = veil.querySelector('span');
  pane.addEventListener('dragenter', (e) => {
    if (!isFiles(e) && !isRows(e)) return;
    e.preventDefault();
    depth++;
    label.textContent = isRows(e) ? (e.shiftKey ? 'Drop to move here' : 'Drop to copy here (Shift: move)') : 'Drop to upload here';
    veil.hidden = false;
  });
  pane.addEventListener('dragover', (e) => {
    if (!isFiles(e) && !isRows(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isRows(e) && e.shiftKey ? 'move' : 'copy';
  });
  pane.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
  pane.addEventListener('drop', async (e) => {
    const rows = isRows(e);
    if (!isFiles(e) && !rows) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    if (rows) {
      let d = null;
      try { d = JSON.parse(e.dataTransfer.getData(ROWS)); } catch (err) { /* not ours */ }
      if (d && d.names && d.names.length) transfer(d.pane, e.shiftKey ? 'move' : 'copy', d.names);
      return;
    }
    setActive(i);
    const list = await filesFromDrop(e.dataTransfer);
    upload(i, list);
  });
  // rows dragged from this pane
  pane.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.fm-row');
    if (!row) return;
    const p = st.panes[i];
    const x = p.items[Number(row.dataset.i)];
    if (!x || (x.type !== 'file' && x.type !== 'folder')) { e.preventDefault(); return; }
    const names = p.sel.has(x.name) ? [...p.sel] : [x.name];
    dragFrom = i;
    e.dataTransfer.setData(ROWS, JSON.stringify({ pane: i, names }));
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  pane.addEventListener('dragend', () => { dragFrom = null; });
}

/* --------------------------------------------------------------- events */

async function onChange(e) {
  const t = e.target;
  if (t.dataset.place != null) {
    const i = Number(t.dataset.place);
    const p = st.panes[i];
    setActive(i);
    if (t.value.startsWith('image:')) await chooseImage(i, t.value.slice(6));
    else Object.assign(p, { place: t.value, image: '', parts: null, dir: '/', error: '' });
    p.sel.clear();
    p.cursor = 0;
    renderPlaces();
    load(i);
    focusList(i);                                        // (not left on the menu: the keys are the list's again)
  } else if (t.dataset.fm === 'file') {
    const files = [...t.files].map((file) => ({ file, path: [] }));
    t.value = '';
    upload(st.active, files);
  }
}

function command(act) {
  const i = st.active;
  if (st.panes[i].image && !st.panes[i].place && ['upload', 'rename', 'mkdir', 'delete', 'download', 'view', 'copy', 'move'].includes(act)) {
    say('Open a partition first (Enter): files go inside one.', true);
    return;
  }
  if (act === 'upload') { if (st.panes[i].place) $('[data-fm="file"]').click(); }
  else if (act === 'rename') renameCmd(i);
  else if (act === 'view') viewCmd(i);
  else if (act === 'copy') transfer(i, 'copy');
  else if (act === 'move') transfer(i, 'move');
  else if (act === 'mkdir') mkdirCmd(i);
  else if (act === 'delete') deleteCmd(i);
  else if (act === 'download') download(i);
  else if (act === 'swap') { setActive(1 - i); root.querySelector(`[data-list="${1 - i}"]`).focus(); }
}

function onClick(e) {
  const b = e.target.closest('button');
  if (b && b.dataset.act === 'cancel') {
    if (st.upload) st.upload.cancel();
    else if (st.job) { st.job.cancelling = true; post('job/cancel', {}).catch((err) => say(err.message, true)); }
    return;
  }
  if (b && b.dataset.act) {
    command(b.dataset.act);
    if (!dlgOpen() && b.dataset.act !== 'swap' && b.dataset.act !== 'upload') focusList();   // (not left on the button)
    return;
  }
  if (b && b.dataset.paneShow != null) { setActive(Number(b.dataset.paneShow)); focusList(); return; }
  const pane = e.target.closest('[data-pane]');
  if (!pane) return;
  const i = Number(pane.dataset.pane);
  if (st.active !== i) setActive(i);
  const row = e.target.closest('.fm-row');
  if (!row) { if (!e.target.closest('select, input, button, a')) focusList(i); return; }
  const n = Number(row.dataset.i);
  const p = st.panes[i];
  if (e.shiftKey) {                                           // a range from the cursor
    const [a, z] = [Math.min(p.cursor, n), Math.max(p.cursor, n)];
    for (let k = a; k <= z; k++) toggleSel(i, k, true);
  } else if (e.ctrlKey || e.metaKey) {
    toggleSel(i, n);
  }
  moveCursor(i, n);
  focusList(i);
}

function onDblClick(e) {
  const row = e.target.closest('.fm-row');
  const pane = e.target.closest('[data-pane]');
  if (!row || !pane) return;
  const i = Number(pane.dataset.pane);
  moveCursor(i, Number(row.dataset.i));
  open(i);
}

let typed = '';
let typedAt = 0;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

function onKey(e) {
  if (!root) return;
  const t = e.target;
  const field = t.closest && t.closest('input, textarea, select');
  if (dlgOpen() || st.upload) {
    // a dialog or an upload has the keys: the page behind must not scroll meanwhile
    if (!field && SCROLL_KEYS.has(e.key)) e.preventDefault();
    return;
  }
  if (field || (t.closest && t.closest('dialog'))) return;
  if (e.altKey) return;
  const i = st.active;
  const p = st.panes[i];
  const k = e.key;
  const fkeys = { F2: 'rename', F3: 'view', F4: 'upload', F5: 'copy', F6: e.shiftKey ? 'rename' : 'move', F7: 'mkdir', F8: 'delete', F9: 'download' };
  const digits = { 2: 'rename', 3: 'view', 4: 'upload', 5: 'copy', 6: 'move', 7: 'mkdir', 8: 'delete', 9: 'download' };
  const plain = !e.ctrlKey && !e.metaKey;
  let handled = true;
  if (k === 'ArrowDown') moveCursor(i, p.cursor + 1);
  else if (k === 'ArrowUp') moveCursor(i, p.cursor - 1);
  else if (k === 'PageDown') moveCursor(i, p.cursor + rowsPerPage(i));
  else if (k === 'PageUp') moveCursor(i, p.cursor - rowsPerPage(i));
  else if (k === 'Home') moveCursor(i, 0);
  else if (k === 'End') moveCursor(i, p.items.length - 1);
  else if (k === 'Enter') open(i);
  else if (k === 'Backspace') up(i);
  else if (k === 'Tab') command('swap');
  else if (k === 'Insert' || (k === ' ' && plain)) { toggleSel(i, p.cursor); moveCursor(i, p.cursor + 1); }
  else if (k === 'Delete') command('delete');
  else if (fkeys[k]) command(fkeys[k]);
  else if (plain && digits[k]) command(digits[k]);
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') { p.items.forEach((x, n) => toggleSel(i, n, true)); }
  else if (plain && k.length === 1 && /\S/.test(k)) {        // type a name's start to jump to it
    const now = Date.now();
    typed = now - typedAt < 1000 ? typed + k.toLowerCase() : k.toLowerCase();
    typedAt = now;
    const at = p.items.findIndex((x) => x.type !== 'up' && x.name.toLowerCase().startsWith(typed));
    if (at >= 0) moveCursor(i, at);
  } else handled = false;
  if (handled) e.preventDefault();
}
