// Hard disk: the ACSI/SCSI IDs, hard disk images and translated drives.
// Every change is saved right away (no Save button); the ST sees a changed
// ID or image after its next reset.
//   GET/PUT /api/v1/settings/acsi         {ids: [8 × off|sd|raw|translated]}
//   GET/PUT /api/v1/settings/hddimage     {path, readOnly, notes{}}, or one action:
//                                         {create:{name,sizeMB}}, {rename:{path,name}}, {delete:path}
//   GET     /api/v1/settings/hddimage/download?path=…
//   GET/PUT /api/v1/settings/translated   letters, USB mount mode, ZIP files
//   status (live): acsi[].media, drives[]  (js/status.js)
// All text from the CosmosEx is escaped (esc) before it goes into HTML.

import { subscribe } from '../status.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MODES = [['off', 'Off'], ['sd', 'SD'], ['raw', 'Raw'], ['translated', 'ce_dd']];
const MODE_HINT = { off: 'not used', sd: 'SD card slot', raw: 'raw disk: HDD image or USB drive', translated: 'translated drives (ce_dd)' };
const SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
const LETTERS = 'CDEFGHIJKLMNOP'.split('');

let root = null;
let st = null;
let unsubStatus = null;

/* ------------------------------------------------------------------ api */

async function api(url, opts = {}) {
  let r;
  try {
    r = await fetch(url, { cache: 'no-store', ...opts });
  } catch (e) {
    await new Promise((res) => setTimeout(res, 300));
    r = await fetch(url, { cache: 'no-store', ...opts });
  }
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
}

const put = (section, data) => api(`/api/v1/settings/${section}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
}).then((r) => r.settings);

/* ---------------------------------------------------------------- mount */

export function mount(el) {
  root = el;
  st = { acsi: null, hdd: null, translated: null, status: null, msg: '', msgBad: false, busy: false };
  drivesHtml = null;
  el.innerHTML = `
    <header class="page-head">
      <div>
        <p class="eyebrow" data-hd="eyebrow">ACSI · 8 IDs</p>
        <h1>Hard disk</h1>
        <p class="page-hint">What the ST finds on its hard disk port: an SD card, a hard disk image or USB drive as a raw disk, and translated drives (folders and USB drives as GEMDOS drives, through the ce_dd driver). Changes are saved right away; the ST sees them after a reset.</p>
      </div>
    </header>
    <p class="fl-message hd-message" data-hd="msg" role="status" aria-live="polite"></p>

    <section class="panel hd-panel" aria-labelledby="hd-bus-h">
      <div class="section-head"><h2 id="hd-bus-h" data-hd="bus-title">ACSI bus</h2><span class="mono hint">ONE SD · ONE CE_DD</span></div>
      <div class="hd-ids" data-hd="ids"><p class="hint">Loading…</p></div>
    </section>

    <section class="panel hd-panel" aria-labelledby="hd-img-h">
      <div class="section-head"><h2 id="hd-img-h">Hard disk images</h2><span class="mono hint" data-hd="folder"></span></div>
      <div data-hd="images"><p class="hint">Loading…</p></div>
    </section>


    <section class="panel hd-panel" aria-labelledby="hd-tr-h">
      <div class="section-head"><h2 id="hd-tr-h">Translated drives</h2><a class="link-action" href="#/config/shared">Shared drive →</a></div>
      <ul class="drive-list" data-hd="drives"></ul>
      <div data-hd="newdrive"></div>
      <div data-hd="translated"></div>
    </section>`;

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  queueMicrotask(() => { if (root === el) unsubStatus = subscribe(onStatus, { fast: true }); });
  load();
}

export function unmount() {
  if (unsubStatus) unsubStatus();
  unsubStatus = null;
  root = null;
}

const $ = (name) => root.querySelector(`[data-hd="${name}"]`);

async function load() {
  try {
    const all = await api('/api/v1/settings');
    if (!root) return;
    st.acsi = all.acsi;
    st.hdd = all.hddimage;
    st.translated = all.translated;
    renderAll();
  } catch (e) {
    if (!root) return;
    say(`Couldn't load the settings: ${e.message}`, true);
  }
}

function say(msg, bad = false) {
  st.msg = msg;
  st.msgBad = bad;
  const p = root && $('msg');
  if (!p) return;
  p.textContent = msg;
  p.classList.toggle('error', bad);
}

function onStatus(s) {
  st.status = s;
  if (!root || !st.acsi) return;
  // only the live text: a full renderIds would replace the image pickers
  // (an open drop-down closed every 2 s)
  updateIdDetails();
  renderDrives();
  if (st.translated && $('newdrive').dataset.free !== freeLetters().join('')) renderNewDrive();
}

function renderAll() {
  renderIds();
  renderImages();
  renderDrives();
  renderTranslated();
}

/* ---------------------------------------------------------------- IDs */

function renderIds() {
  const iface = st.acsi.interface || 'ACSI';
  $('bus-title').textContent = `${iface} bus`;
  $('eyebrow').textContent = `${iface} · 8 IDs`;
  $('ids').innerHTML = st.acsi.ids.map((m, id) => {
    const detail = idDetail(m, id);
    const slot = st.hdd && st.hdd.ids ? st.hdd.ids[id] : null;
    const imgs = st.hdd ? [...(st.hdd.images || []), ...(st.hdd.usbImages || [])] : [];
    const pick = m === 'raw' && st.hdd ? `<div class="hd-id-img">
          <select class="select" data-idimg="${id}" aria-label="Image on ID ${id}"${st.busy ? ' disabled' : ''}>
            <option value=""${slot && slot.path ? '' : ' selected'}>No image (a USB drive, if raw)</option>
            ${imgs.map((x) => `<option value="${esc(x.path)}"${slot && slot.path === x.path ? ' selected' : ''}>${esc(x.name)} · ${fmtMB(x.sizeMB)}${x.id >= 0 && x.id !== id ? ` (on ID ${x.id})` : ''}</option>`).join('')}
            ${slot && slot.path && !imgs.some((x) => x.path === slot.path) ? `<option value="${esc(slot.path)}" selected>${esc(slot.path)}</option>` : ''}
          </select>
          ${slot && slot.path ? `<label class="cf-check"><input type="checkbox" data-idro="${id}"${slot.readOnly ? ' checked' : ''}>Read only</label>` : ''}
        </div>` : (slot && slot.path ? `<p class="hint cf-warn hd-id-warn">${esc(slot.path.split('/').pop())} is set for this ID: set it to Raw to use it.</p>` : '');
    return `<div class="hd-id${m === 'off' ? ' off' : ''}">
        <div class="hd-id-top"><span class="mono id-num">ID ${id}</span><span class="mono hd-id-detail" title="${esc(detail)}">${esc(detail)}</span></div>
        <div class="segmented" role="radiogroup" aria-label="ID ${id}">
          ${MODES.map(([v, t]) => `<button type="button" role="radio" aria-checked="${m === v}" data-id="${id}" data-mode="${v}"${st.busy ? ' disabled' : ''}>${t}</button>`).join('')}
        </div>
        ${pick}
      </div>`;
  }).join('');
}

// the live text next to an ID (what's attached; for ce_dd its drive letters)
function idDetail(m, id) {
  const l = ((st.status && st.status.acsi) || [])[id] || {};
  if (m === 'translated') {
    const letters = ((st.status && st.status.drives) || []).map((d) => d.letter).join(' ');
    return letters ? `drives ${letters}` : MODE_HINT[m];
  }
  if (m !== 'off' && l.media) return l.media;
  if (m !== 'off' && l.mode === m) return 'nothing attached';
  return MODE_HINT[m];
}

function updateIdDetails() {
  root.querySelectorAll('.hd-id-detail').forEach((el, id) => {
    const d = idDetail(st.acsi.ids[id], id);
    if (el.textContent !== d) { el.textContent = d; el.title = d; }
  });
}

async function setMode(id, mode) {
  const ids = [...st.acsi.ids];
  // only one SD and one ce_dd: picking one clears it elsewhere
  if (mode === 'sd' || mode === 'translated') ids.forEach((m, i) => { if (m === mode && i !== id) ids[i] = 'off'; });
  ids[id] = mode;
  await save('acsi', { ids }, `ID ${id}: ${MODES.find((x) => x[0] === mode)[1]}. The ST sees it after a reset.`);
  // the image section says which IDs are raw
  st.hdd = await api('/api/v1/settings/hddimage').catch(() => st.hdd);
  if (root) renderAll();
}

async function save(section, data, okMsg) {
  st.busy = true;
  try {
    const r = await put(section, data);
    if (!root) return false;
    if (section === 'acsi') st.acsi = r;
    if (section === 'hddimage') st.hdd = r;
    if (section === 'translated') st.translated = r;
    if (okMsg) say(okMsg);
    return true;
  } catch (e) {
    if (root) say(e.message, true);
    return false;
  } finally {
    st.busy = false;
    if (root) renderAll();
  }
}

/* ------------------------------------------------------------- images */

const fmtMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);
const dl = (path) => `/api/v1/settings/hddimage/download?path=${encodeURIComponent(path)}`;

function renderImages() {
  const d = st.hdd;
  $('folder').textContent = d.folder || '';
  const imgs = d.images || [];
  const usb = d.usbImages || [];
  const all = [...imgs, ...usb];
  const freeId = st.acsi ? st.acsi.ids.indexOf('off') : -1;
  const on = (d.ids || []).filter((x) => x.path);

  let html = '<div class="hd-attached"><div><p class="eyebrow">Attached</p>';
  if (on.length) {
    html += `<ul class="hd-att-list">${on.map((x) => {
      const im = all.find((y) => y.path === x.path);
      return `<li><span class="mono id-num">ID ${x.id}</span> <span class="mono hd-att-name">${esc(im ? im.name : x.path)}</span>
        ${x.readOnly ? '<span class="hint">read only</span>' : ''}${x.raw ? '' : ' <span class="hint cf-warn">ID not Raw: not used</span>'}
        <button type="button" class="btn-link" data-act="detach-id" data-id="${x.id}">Detach</button></li>`;
    }).join('')}</ul>`;
  } else {
    html += '<p class="hint">No image: the raw IDs serve USB drives (when mounted as raw). Attach images below, or pick one on a Raw ID above (one image per ID; several IDs, several disks).</p>';
  }
  html += '</div></div>';
  if (on.length && !d.rawIdSet) {
    html += `<p class="hint cf-warn hd-warn">No ID is set to Raw, so the ST doesn't see the images.
      ${freeId >= 0 ? `<button type="button" class="btn-link" data-act="useid" data-id="${freeId}">Use ID ${freeId} as Raw</button>` : 'Set one above.'}</p>`;
  }
  const att = all.find((x) => x.path === d.path);

  // the CosmosEx's own images
  html += `<div role="list" class="hd-rows" aria-label="Images on the CosmosEx">${imgs.length ? imgs.map(row).join('')
    : `<p class="hint hd-empty">No images in <span class="mono">${esc(d.folder)}</span> yet: make a blank one below, or copy one there over the network (<a href="#/config/storageshare">Storage sharing</a>).</p>`}</div>`;
  if (usb.length) {
    html += `<h3 class="ov-sub">On USB drives</h3><div role="list" class="hd-rows" aria-label="Images on USB drives">${usb.map(row).join('')}</div>`;
  }

  // new blank image, another file
  html += `<div class="hd-tools">
    <fieldset class="cf-box cf-hdd-new">
      <legend>New blank image</legend>
      <div class="cf-grid">
        <label class="field"><span>Name</span>
          <input class="input mono" data-new="name" maxlength="64" placeholder="games" spellcheck="false" autocomplete="off"></label>
        <label class="field"><span>Size</span>
          <select class="select" data-new="size">${SIZES.map((mb) => `<option value="${mb}"${mb === 1024 ? ' selected' : ''}>${fmtMB(mb)}</option>`).join('')}</select></label>
      </div>
      <div class="cf-hdd-new-go"><button type="button" class="btn btn-secondary" data-act="create">Create</button></div>
      <p class="hint">A file of zeros (like <span class="mono">mkfile 1024m</span>; <span class="mono">.img</span> is added to a name without one). Attach it, then partition and format it on the ST with your hard disk driver (HDDRIVER, ICD…). ACSI reaches at most 1 GB of a disk; older TOS versions and drivers limit the partition size.</p>
    </fieldset>
    <details class="cf-box hd-other"${d.path && !att ? ' open' : ''}>
      <summary>Another file</summary>
      <label class="field"><span>Path (under /mnt/ or /storage/)</span>
        <input class="input mono" data-other value="${esc(d.path && !att ? d.path : '')}" placeholder="/mnt/sda1/atari/disk.img" spellcheck="false"></label>
      <div class="cf-hdd-new-go"><button type="button" class="btn btn-secondary" data-act="attach-other">Attach</button></div>
      <p class="hint">Not on the shared drive: a dropped network connection can corrupt the image.</p>
    </details>
  </div>`;
  $('images').innerHTML = html;
}

function row(x) {
  const mine = x.where === 'storage';
  return `<div role="listitem" class="hd-row${x.attached ? ' on' : ''}" data-path="${esc(x.path)}">
      <div class="hd-row-main">
        <span class="mono hd-name">${esc(x.name)}</span>
        <span class="mono hint">${fmtMB(x.sizeMB)}${mine ? '' : ` · ${esc(x.drive)}`}</span>
        ${x.attached ? `<span class="hd-badge mono">${x.id >= 0 ? `ID ${x.id}` : 'ATTACHED'}</span>` : ''}
      </div>
      ${mine ? `<textarea class="input hd-notes" rows="1" maxlength="4000" data-notes="${esc(x.name)}" placeholder="Notes: what's on it, driver, TOS, partitions" aria-label="Notes about ${esc(x.name)}">${esc(x.notes || '')}</textarea>` : '<span></span>'}
      <div class="hd-acts">
        ${x.attached ? '<button type="button" class="btn btn-secondary" data-act="detach">Detach</button>'
          : '<button type="button" class="btn btn-primary" data-act="attach">Attach</button>'}
        <button type="button" class="btn btn-secondary" data-act="inspect"${x.attached && !(st.hdd.ids || []).some((i) => i.path === x.path && i.readOnly) ? ' title="The ST has it attached read-write: detach it or make it read-only to look inside"' : ''}>Look inside</button>
        <a class="btn btn-secondary" href="${dl(x.path)}" download="${esc(x.name)}">Download</a>
        ${mine ? `<button type="button" class="btn btn-secondary" data-act="rename">Rename</button>
          <button type="button" class="btn btn-secondary btn-danger" data-act="delete"${x.attached ? ' disabled title="Detach it first"' : ''}>Delete</button>` : ''}
      </div>
    </div>`;
}

/* -------------------------------------------------------- translated */

const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
const holds = (f) => (f.files ? `${f.more ? 'more than ' : ''}${f.files.toLocaleString()} item${f.files === 1 ? '' : 's'}, ${fmtBytes(f.bytes)}` : 'empty');
const filesLink = (letter) => `#/files?l=${encodeURIComponent(`tr:${letter}|/`)}`;

// The drives the ST has now (status), and the folder drives that aren't among
// them yet (just made, or skipped by the app: the row says why)
let drivesHtml = null;
function renderDrives() {
  const drives = (st.status && st.status.drives) || [];
  const folders = (st.translated && st.translated.folders) || [];
  const byPath = new Map(folders.map((f) => [f.path, f]));
  const live = new Set(drives.map((d) => d.path));
  const actions = (f) => `<span class="drive-acts">
      <a class="btn-link" href="${filesLink(f.letter)}">Open in Files</a>
      <button type="button" class="btn-link" data-act="drive-remove" data-letter="${esc(f.letter)}"${st.busy ? ' disabled' : ''}>Remove</button>
    </span>`;
  const rows = drives.map((d) => {
    const f = byPath.get(d.path);
    return `<li${f ? ` data-drive="${esc(f.letter)}"` : ''}>
      <span class="mono drive-letter">${esc(d.letter)}</span>
      <span class="drive-source">${f ? `Folder on the CosmosEx <span class="hint">· ${esc(holds(f))}</span>` : esc(d.source || '')}</span>
      <span class="mono drive-free">${d.free_mb != null ? `${esc(fmtMB(d.free_mb))} free` : ''}</span>
      ${f ? actions(f) : ''}
    </li>`;
  });
  folders.filter((f) => !live.has(f.path)).forEach((f) => rows.push(`<li data-drive="${esc(f.letter)}">
      <span class="mono drive-letter">${esc(f.letter)}:</span>
      <span class="drive-source">Folder on the CosmosEx <span class="hint">· ${esc(holds(f))}</span> <span class="hint${f.problem ? ' cf-warn' : ''}">· ${esc(f.problem || 'not a drive yet')}</span></span>
      ${actions(f)}
    </li>`));
  const html = rows.length ? rows.join('')
    : '<li class="drive-empty hint">No translated drives now: create one below, plug in a USB drive, or set up the shared drive.</li>';
  // only when something changed: the status comes every 2 s, and a row's link may have the focus
  if (html !== drivesHtml) { drivesHtml = html; $('drives').innerHTML = html; }
}

// "Create drive": a folder on the CosmosEx's storage as a drive, with a letter
// nothing has now
function freeLetters() {
  const d = st.translated || {};
  const used = new Set([d.sharedLetter, d.configLetter, ...(d.folders || []).map((f) => f.letter),
    ...((st.status && st.status.drives) || []).map((x) => String(x.letter || '').charAt(0).toUpperCase())]);
  return LETTERS.filter((l) => !used.has(l));
}

function renderNewDrive() {
  const el = $('newdrive');
  if (!el || !st.translated) return;
  const free = freeLetters();
  const was = el.querySelector('select')?.value;
  const ceddId = st.acsi ? st.acsi.ids.indexOf('translated') : 0;
  const offId = st.acsi ? [1, 2, 3, 4, 5, 6, 0, 7].find((i) => st.acsi.ids[i] === 'off') : undefined;
  const noCedd = st.acsi && ceddId < 0
    ? `<p class="hint cf-warn hd-warn" data-hd="nocedd">No ID is set to ce_dd, so the ST doesn't see translated drives.
        ${offId != null ? `<button type="button" class="btn-link" data-act="usecedd" data-id="${offId}">Use ID ${offId} for translated drives</button>` : 'Set one above.'}</p>` : '';
  // not under the user's hand: the status re-renders this too (a USB drive took a letter)
  if (el.contains(document.activeElement) && el.querySelector('select') && !st.busy && el.dataset.free === free.join('')) return;
  el.dataset.free = free.join('');
  el.innerHTML = `${noCedd}
    <div class="hd-newdrive">
      <label class="field"><span>New drive on the CosmosEx</span>
        <select class="select" data-newdrive${free.length ? '' : ' disabled'}>
          ${free.length ? free.map((l) => `<option value="${l}"${l === was ? ' selected' : ''}>${l}:</option>`).join('') : '<option value="">no letter free</option>'}
        </select></label>
      <button type="button" class="btn btn-secondary" data-act="drive-create"${free.length && !st.busy ? '' : ' disabled'}>Create drive</button>
      <p class="hint">A folder on the CosmosEx's own storage (<span class="mono">${esc(st.translated.folderRoot || '/storage')}/translated_&lt;letter&gt;</span>) that the ST gets as a drive. It has no size of its own: it uses the storage's free space.</p>
    </div>`;
}

function renderTranslated() {
  const d = st.translated;
  const sel = (key, label, v) => `<label class="field"><span>${label}</span>
      <select class="select" data-tr="${key}">
        <option value=""${v ? '' : ' selected'}>None</option>
        ${LETTERS.map((l) => `<option value="${l}"${v === l ? ' selected' : ''}>${l}:</option>`).join('')}
      </select></label>`;
  const radio = (key, legend, opts, value) => `<fieldset class="cf-radio"><legend>${legend}</legend>
      ${opts.map(([v, l]) => `<label class="cf-check"><input type="radio" name="hd-${key}" data-tr="${key}" value="${v}"${String(value) === v ? ' checked' : ''}>${l}</label>`).join('')}
    </fieldset>`;
  $('translated').innerHTML = `
    <div class="cf-grid hd-tr">
      ${sel('firstLetter', 'First translated drive', d.firstLetter)}
      ${sel('sharedLetter', 'Shared drive', d.sharedLetter)}
      ${sel('configLetter', 'Config drive', d.configLetter)}
    </div>
    <div class="cf-radios">
      ${radio('mountRawNotTrans', 'Mount USB drives as', [['false', 'Translated'], ['true', 'Raw']], d.mountRawNotTrans)}
      ${radio('useZipDir', 'Access ZIP files as', [['false', 'Files'], ['true', 'Directories']], d.useZipDir)}
    </div>
    <p class="hint">With raw disks as well, start the translated letters after C: to leave room for them. Drives from folders keep their own letters; USB drives skip those.</p>`;
  renderNewDrive();
}

function readTranslated() {
  const v = (k) => root.querySelector(`select[data-tr="${k}"]`).value || null;
  const r = (k) => root.querySelector(`input[data-tr="${k}"]:checked`)?.value === 'true';
  return { firstLetter: v('firstLetter'), sharedLetter: v('sharedLetter'), configLetter: v('configLetter'),
    mountRawNotTrans: r('mountRawNotTrans'), useZipDir: r('useZipDir') };
}

/* ------------------------------------------------------------- events */

// an image onto the first raw ID without one; none free: offer the first
// unused ID as Raw
async function attachToFreeId(path, name) {
  const ids = (st.hdd && st.hdd.ids) || [];
  let id = st.acsi.ids.findIndex((m, i) => m === 'raw' && !(ids[i] && ids[i].path));
  if (id < 0) {
    const off = st.acsi.ids.indexOf('off');
    if (off < 0) { say('No ID is free: set one to Raw above (each image needs its own Raw ID).', true); return; }
    if (!window.confirm(`No Raw ID is free for ${name}. Use ID ${off} as Raw for it?`)) return;
    await setMode(off, 'raw');
    id = off;
  }
  await save('hddimage', { attach: { path, id, readOnly: false } }, `${name} attached on ID ${id}. The ST sees it after a reset.`);
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.mode) { setMode(Number(b.dataset.id), b.dataset.mode); return; }
  const act = b.dataset.act;
  if (!act) return;
  const rowEl = b.closest('[data-path]');
  const path = rowEl ? rowEl.dataset.path : null;
  const name = path ? path.split('/').pop() : '';

  if (act === 'inspect') { location.hash = `#/files?l=${encodeURIComponent(`image:${path}`)}`; return; }
  if (act === 'attach') {
    await attachToFreeId(path, name);
  } else if (act === 'detach') {
    await save('hddimage', { detach: { path } }, `${name} detached. The ST loses the disk after a reset.`);
  } else if (act === 'detach-id') {
    await save('hddimage', { detach: { id: Number(b.dataset.id) } }, `ID ${b.dataset.id}: image detached. The ST loses the disk after a reset.`);
  } else if (act === 'useid') {
    await setMode(Number(b.dataset.id), 'raw');
  } else if (act === 'usecedd') {
    await setMode(Number(b.dataset.id), 'translated');
  } else if (act === 'drive-create') {
    const letter = root.querySelector('[data-newdrive]').value;
    if (!letter) return;
    if (await save('translated', { createDrive: { letter } }, `Drive ${letter}: is made. The ST sees it after its next reset.`)) root.querySelector(`[data-drive="${letter}"] a`)?.focus();
  } else if (act === 'drive-remove') {
    const letter = b.dataset.letter;
    const f = ((st.translated && st.translated.folders) || []).find((x) => x.letter === letter);
    if (!f) return;
    const ask = f.files
      ? `Remove drive ${letter}: and delete what's on it (${holds(f)})? This can't be undone.`
      : `Remove the empty drive ${letter}:?`;
    if (!window.confirm(ask)) return;
    await save('translated', { removeDrive: { letter, withFiles: f.files > 0 } }, `Drive ${letter}: is removed. The ST loses it after its next reset.`);
  } else if (act === 'attach-other') {
    const p = root.querySelector('[data-other]').value.trim();
    if (!p) { say('Type the image\'s path first.', true); return; }
    await attachToFreeId(p, p.split('/').pop());
  } else if (act === 'rename') {
    const to = window.prompt(`New name for ${name}:`, name);
    if (!to || to.trim() === name) return;
    await save('hddimage', { rename: { path, name: to.trim() } }, `${name} is now ${to.trim()}.`);
  } else if (act === 'delete') {
    if (!window.confirm(`Delete ${name}? Everything on it is lost (download it first to keep a copy).`)) return;
    await save('hddimage', { delete: path }, `${name} deleted.`);
  } else if (act === 'create') {
    const n = root.querySelector('[data-new="name"]').value.trim();
    const sizeMB = Number(root.querySelector('[data-new="size"]').value);
    if (!n) { say('Give the new image a name.', true); return; }
    b.textContent = 'Creating…';
    const file = n.includes('.') ? n : `${n}.img`;
    await save('hddimage', { create: { name: n, sizeMB } }, `Made ${file} (${fmtMB(sizeMB)}). Attach it, then partition it on the ST.`);
  }
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.idimg != null) {                      // the image picker on a Raw ID
    const id = Number(t.dataset.idimg);
    if (t.value) save('hddimage', { attach: { path: t.value, id, readOnly: false } }, `ID ${id}: ${t.value.split('/').pop()}. The ST sees it after a reset.`);
    else save('hddimage', { detach: { id } }, `ID ${id}: no image. The ST loses the disk after a reset.`);
  } else if (t.dataset.idro != null) {
    const id = Number(t.dataset.idro);
    save('hddimage', { attach: { path: st.hdd.ids[id].path, id, readOnly: t.checked } }, t.checked ? `ID ${id}: read only, the ST can't change the image.` : `ID ${id}: the ST can change the image again.`);
  } else if (t.dataset.notes != null) {
    const notes = { [t.dataset.notes]: t.value };
    // notes don't re-render the list (keeps the cursor and other edits)
    api('/api/v1/settings/hddimage', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) })
      .then(() => say(`Notes for ${t.dataset.notes} saved.`))
      .catch((err) => say(err.message, true));
  } else if (t.dataset.tr) {
    save('translated', readTranslated(), 'Translated drive settings saved.');
  }
}
