// Floppy (stage 7.4): the three slots and the image library.
//   slots:   GET /api/v1/floppy, PUT /api/v1/floppy/<n> (select for A:),
//            DELETE /api/v1/floppy/<n> (eject), POST /api/v1/floppy/<n> (upload)
//   library: GET /api/v1/library/search, GET /api/v1/library/sources,
//            GET /api/v1/download/download|insert|downloading (existing)
// All text from lists is escaped (esc) before it goes into HTML.

import { subscribe } from '../status.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGE_SIZE = 15;
const SLOT_POLL_MS = 2000;

let root = null;
let timer = null;
let searchTimer = null;
let state = null;
let unsubStatus = null;

function freshState() {
  return {
    slots: ['', '', ''],
    active: null,
    q: '',
    source: '',            // '' = all sources, else a source id
    page: 0,
    result: null,          // last /library/search answer
    sources: null,         // last /library/sources answer
    games: new Map(),      // image stem (lower case) -> games, from search results, for the slot cards
    pending: new Map(),    // image -> { slot, percent } while downloading, inserted when done
    pics: new Map(),       // sourceId -> { entryId: {url|n, caption} } from extended lists (listworker.js)
    message: '',
    searchSeq: 0,
  };
}

/* ------------------------------------------------------------------ api */

// fetch, retried once when the connection itself fails (seen with parallel
// requests in QEMU: "connection reset"); HTTP errors are not retried
async function fetchRetry(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 300));
    return fetch(url, opts);
  }
}

async function api(url, opts = {}) {
  const r = await fetchRetry(url, { cache: 'no-store', ...opts });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) { /* not JSON */ }
    throw new Error(msg);
  }
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return t; }
}

const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/* ---------------------------------------------------------------- mount */

export function mount(el) {
  root = el;
  state = freshState();
  queueMicrotask(() => { if (root === el) unsubStatus = subscribe(showClock); });
  el.innerHTML = `
    <header class="page-head">
      <div>
        <p class="eyebrow">Drive A: · 3 slots</p>
        <h1>Floppy emulation</h1>
        <p class="page-hint">The selected slot is what the ST sees in drive A:. Drop .ST, .MSA or .ZIP images onto a slot, or pick one from the library.</p>
      </div>
    </header>

    <section aria-label="Slots">
      <div class="fl-slots" data-fl="slots"></div>
      <p class="fl-message" data-fl="message" role="status" aria-live="polite"></p>
      <p class="fl-own">
        <span class="mono hint">COSMOSEX DISKS</span>
        <button type="button" class="btn btn-secondary" data-act="own" data-own="100" data-name="CosmosEx config disk" title="ce_conf.st: CE_CONF and the drivers, to set the CosmosEx up from the ST">Config disk</button>
        <button type="button" class="btn btn-secondary" data-act="own" data-own="101" data-name="floppy test disk" title="fdd_test.st: the disk CE_FDD's floppy test reads">Floppy test disk</button>
        <span class="hint">go into slot 1, as a copy: what the ST writes to them isn't kept.</span>
      </p>
    </section>

    <section class="panel fl-lib" aria-labelledby="fl-lib-h">
      <div class="section-head">
        <h2 id="fl-lib-h">Image library</h2>
        <span class="mono hint" data-fl="storage"></span>
      </div>
      <p class="fl-clock" data-fl="clock" role="status" hidden>The CosmosEx's clock isn't set yet (it has no clock battery and sets itself from the internet a minute or so after it starts). Until then, downloads from https:// addresses fail: try again shortly.</p>

      <div class="fl-tools">
        <label class="fl-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>
          <span class="sr-only">Search images and games</span>
          <input type="search" data-fl="q" placeholder="Search a game or disk, e.g. gods" autocomplete="off">
        </label>
        <div class="segmented" role="group" aria-label="Source" data-fl="sources"></div>
      </div>

      <div class="fl-foot fl-foot-top mono">
        <span data-fl="count2"></span>
        <div class="fl-pager">
          <button type="button" class="fl-pg" data-fl="prev2" aria-label="Previous page">‹</button>
          <span data-fl="pageinfo2"></span>
          <button type="button" class="fl-pg" data-fl="next2" aria-label="Next page">›</button>
        </div>
      </div>

      <div role="list" aria-label="Images" class="fl-rows" data-fl="rows" aria-busy="true"></div>

      <div class="fl-foot mono">
        <span data-fl="count"></span>
        <div class="fl-pager">
          <button type="button" class="fl-pg" data-fl="prev" aria-label="Previous page">‹</button>
          <span data-fl="pageinfo"></span>
          <button type="button" class="fl-pg" data-fl="next" aria-label="Next page">›</button>
        </div>
      </div>
      <p class="hint fl-manage"><a href="#/config/library">Library sources →</a> <span data-fl="sourcesummary"></span></p>
    </section>`;

  const q = $('q');
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = q.value.trim(); state.page = 0; search(); }, 150);
  });
  // the same pager above and below the list
  for (const n of ['', '2']) {
    $(`prev${n}`).addEventListener('click', () => { if (state.page > 0) { state.page--; search(); } });
    $(`next${n}`).addEventListener('click', () => {
      if (state.result && state.page < state.result.pages - 1) { state.page++; search(); }
    });
  }

  el.addEventListener('click', onClick);
  // the picture "buttons" are spans: Enter / Space open the lightbox too
  el.addEventListener('keydown', (e) => {
    const t = e.target.closest && e.target.closest('[data-act="pics"]');
    if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick({ target: t }); }
  });
  el.addEventListener('change', onFileChosen);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);

  renderSlots();
  loadSources();
  search();
  pollSlots();
}

export function unmount() {
  if (lb.dialog) { lb.dialog.remove(); lb.dialog = null; }
  if (unsubStatus) { unsubStatus(); unsubStatus = null; }
  if (worker) { worker.terminate(); worker = null; }
  clearInterval(cycleTimer);
  cycleTimer = null;
  clearTimeout(timer);
  clearTimeout(searchTimer);
  timer = null;
  root = null;
}

const $ = (name) => root.querySelector(`[data-fl="${name}"]`);

function say(text) {
  state.message = text;
  const m = root && $('message');
  if (m) m.textContent = text;
}

/* ---------------------------------------------------------------- slots */

async function pollSlots() {
  if (!root) return;
  try {
    const f = await api('/api/v1/floppy');
    state.slots = (f.slots || ['', '', '']).map((s) => s || '');
    state.active = f.active ?? null;
    renderSlots();
    if (state.pending.size) await checkDownloads();
  } catch (e) { /* the shell's connection bar shows it */ }
  if (root) timer = setTimeout(pollSlots, SLOT_POLL_MS);
}

const stem = (name) => String(name || '').replace(/\.(zip|st|msa)$/i, '').toLowerCase();

function prettyName(file) {
  return String(file || '').replace(/\.(zip|st|msa)$/i, '').replace(/_+/g, ' ').trim();
}

function renderSlots() {
  if (!root) return;
  $('slots').innerHTML = state.slots.map((name, i) => {
    const active = name && state.active === i;
    const n = i + 1;
    if (!name) {
      return `<div class="fl-slot empty" data-slot="${i}">
          <div class="fl-slot-head"><span class="mono fl-slot-n">SLOT ${n}</span></div>
          <label class="fl-drop">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"></path></svg>
            <span class="fl-drop-title">Drop image or browse</span>
            <span class="fl-drop-hint">or pick from the library below</span>
            <input type="file" accept=".st,.msa,.zip" class="sr-only" data-upload="${i}" aria-label="Upload an image to slot ${n}">
          </label>
        </div>`;
    }
    const allGames = state.games.get(stem(name)) || [];
    const games = allGames.length === 1 ? [] : allGames;
    const gamesHtml = games.length
      ? `<div class="fl-ondisk"><div class="mono fl-ondisk-h">ON THIS DISK</div><ul>${games.slice(0, 8).map((g) => `<li>${esc(g)}</li>`).join('')}${games.length > 8 ? `<li class="more">+ ${games.length - 8} more</li>` : ''}</ul></div>`
      : '';
    return `<div class="fl-slot${active ? ' active' : ''}" data-slot="${i}">
        <div class="fl-slot-head">
          <span class="mono fl-slot-n">SLOT ${n}</span>
          ${active ? '<span class="fl-badge">In drive A:</span>' : ''}
        </div>
        <div class="fl-slot-body">
          <div class="fl-slot-name">${esc(titleFor(name, allGames))}</div>
          <div class="mono fl-slot-meta">${esc(name)}</div>
          ${gamesHtml}
        </div>
        <div class="fl-slot-btns">
          <button type="button" class="btn ${active ? 'btn-secondary' : 'btn-primary'} fl-select" data-act="select" data-slot="${i}" aria-pressed="${active ? 'true' : 'false'}">${active ? 'Selected' : 'Select for A:'}</button>
          <button type="button" class="btn btn-secondary" data-act="eject" data-slot="${i}" aria-label="Eject slot ${n}">Eject</button>
        </div>
      </div>`;
  }).join('');
}

async function selectSlot(i) {
  try {
    await api(`/api/v1/floppy/${i}`, { method: 'PUT' });
    state.active = i;
    renderSlots();
    say(`Slot ${i + 1} is now in drive A:.`);
  } catch (e) { say(`Couldn't select slot ${i + 1}: ${e.message}`); }
}

async function ejectSlot(i) {
  try {
    await api(`/api/v1/floppy/${i}`, { method: 'DELETE' });
    state.slots[i] = '';
    renderSlots();
    say(`Slot ${i + 1} ejected.`);
    search();
  } catch (e) { say(`Couldn't eject slot ${i + 1}: ${e.message}`); }
}

// The app's own images (ce_conf.st, fdd_test.st): the app puts a fresh copy
// in slot 1 and selects it (PUT /api/v1/floppy/100 or 101)
async function insertOwn(id, name) {
  if (state.slots[0] && !window.confirm(`Put the ${name} in slot 1? It replaces ${state.slots[0]} there.`)) return;
  try {
    await api(`/api/v1/floppy/${id}`, { method: 'PUT' });
    say(`The ${name} is in slot 1 and in drive A:.`);
    pollSlotsSoon();
  } catch (e) { say(`Couldn't insert the ${name}: ${e.message}`); }
}

async function upload(i, file) {
  if (!file) return;
  if (!/\.(st|msa|zip)$/i.test(file.name)) { say('Only .ST, .MSA or .ZIP images.'); return; }
  const fd = new FormData();
  fd.append('file', file, file.name);
  say(`Uploading ${file.name} to slot ${i + 1}…`);
  try {
    await api(`/api/v1/floppy/${i}`, { method: 'POST', body: fd });
    say(`${file.name} is in slot ${i + 1}.`);
    pollSlotsSoon();
  } catch (e) { say(`Upload failed: ${e.message}`); }
}

function pollSlotsSoon() {
  clearTimeout(timer);
  timer = setTimeout(pollSlots, 300);
}

function onFileChosen(e) {
  const input = e.target.closest('[data-upload]');
  if (input) upload(Number(input.dataset.upload), input.files[0]);
}

function onDragOver(e) {
  const card = e.target.closest('.fl-slot');
  if (!card || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  card.classList.add('drag');
}

function onDragLeave(e) {
  const card = e.target.closest('.fl-slot');
  if (card && !card.contains(e.relatedTarget)) card.classList.remove('drag');
}

function onDrop(e) {
  const card = e.target.closest('.fl-slot');
  if (!card) return;
  e.preventDefault();
  card.classList.remove('drag');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  upload(Number(card.dataset.slot), file);
}

/* -------------------------------------------------------------- library */

async function loadSources() {
  try {
    state.sources = await api('/api/v1/library/sources');
  } catch (e) {
    state.sources = null;
  }
  if (!root) return;
  renderSources();
  // rows drawn before the sources were known have no picture boxes yet
  if (state.result && state.result.results && state.result.results.some((it) => sourceFormat(it.sourceId) === 'json')) renderRows();
}

function shortLabel(src) {
  if (src.type === 'web') return src.label.replace(/^WEB /, '');
  const folder = (src.path || '/').split('/').filter(Boolean).pop();
  return `${src.type === 'share' ? 'Share' : src.type === 'local' ? 'Local' : 'USB'}${folder ? ` ${folder}` : ''}`;
}

function renderSources() {
  if (!root) return;
  const s = state.sources;
  const enabled = s ? s.sources.filter((x) => x.enabled) : [];
  if (state.source && !enabled.some((x) => x.id === state.source)) state.source = '';

  // the segmented control only when there's something to choose
  const opts = [{ id: '', label: 'All' }, ...enabled.map((x) => ({ id: x.id, label: shortLabel(x) }))];
  $('sources').innerHTML = opts.length > 2 ? opts.map((o) => `<button type="button" data-act="source" data-id="${esc(o.id)}" aria-pressed="${state.source === o.id}">${esc(o.label)}</button>`).join('') : '';
  $('sources').hidden = opts.length <= 2;

  renderStorage();

  if (s) {
    const summary = s.sources.map((x) => {
      const st = x.enabled ? x.status : 'disabled';
      return `${shortLabel(x)}: ${st.replace('_', ' ')}${x.entries ? ` (${x.entries})` : ''}`;
    }).join(' · ');
    $('sourcesummary').textContent = summary;
  }
}

// where downloads go (IMAGE_STORAGE), from the last search answer
function renderStorage() {
  if (!root) return;
  const dl = state.result && state.result.downloads;
  const el = $('storage');
  if (!dl) { const s = state.sources && state.sources.storage; el.textContent = s ? `downloads → ${s}` : ''; el.classList.remove('fl-warn'); return; }
  if (dl.kind === 'ram') {
    el.textContent = dl.fallback
      ? `downloads → RAM (${dl.setting === 'auto' ? 'no storage attached' : `${dl.setting} not available`}): gone after power-off, saves to them are lost`
      : 'downloads → RAM: gone after power-off; plug in a USB drive or set up the shared drive';
    el.classList.add('fl-warn');
  } else {
    el.textContent = `downloads → ${dl.path}`;
    el.classList.remove('fl-warn');
  }
}

async function search() {
  if (!root) return;
  const seq = ++state.searchSeq;
  $('rows').setAttribute('aria-busy', 'true');
  let r;
  try {
    r = await api(`/api/v1/library/search?${qs({ q: state.q, page: state.page, size: PAGE_SIZE, source: state.source })}`);
  } catch (e) {
    if (seq !== state.searchSeq || !root) return;
    $('rows').innerHTML = `<div class="fl-empty">Couldn't search the library: ${esc(e.message)}</div>`;
    $('rows').setAttribute('aria-busy', 'false');
    return;
  }
  if (seq !== state.searchSeq || !root) return;     // an older answer, a newer search is under way
  state.result = r;
  for (const it of r.results || []) state.games.set(stem(it.image), it.games || []);
  renderStorage();
  renderRows();
  renderSlots();
  if (r.status === 'downloading') {                 // list still coming: ask again shortly
    setTimeout(() => { if (root && seq === state.searchSeq) { loadSources(); search(); } }, 2000);
  }
}

function highlight(g) {
  const q = state.q.toLowerCase();
  return q && g.toLowerCase().includes(q);
}

function sourceFormat(id) {
  const src = state.sources && state.sources.sources.find((x) => x.id === id);
  return src ? src.format : '';
}

// Pictures of extended (JSON) lists: the list is fetched and parsed in a Web
// Worker once per source (the server's ETag keeps repeats cheap), then each
// row gets its entry's picture
let worker = null;

// Pictures are loaded a few at a time. The CosmosEx fetches each from its own
// site when asked (up to 5 s), and a browser has about 6 connections to the
// CosmosEx: a page of rows with all their pictures asked for at once took
// every one of them for a long while, and the status check behind them timed
// out ("Lost connection"). Each row's first picture goes before the others.
const PIC_AT_ONCE = 3;
const picQueue = { first: [], rest: [], busy: 0 };
function loadPicture(img, src, first) {
  (first ? picQueue.first : picQueue.rest).push({ img, src });
  pumpPictures();
}
function pumpPictures() {
  while (picQueue.busy < PIC_AT_ONCE) {
    const job = picQueue.first.shift() || picQueue.rest.shift();
    if (!job) return;
    if (!job.img.isConnected) continue;                // its row is gone (another page, another search)
    picQueue.busy++;
    let done = false;
    const free = () => { if (done) return; done = true; picQueue.busy--; pumpPictures(); };
    job.img.addEventListener('load', free, { once: true });
    job.img.addEventListener('error', free, { once: true });
    setTimeout(free, 8000);                            // never stuck on one picture
    job.img.src = job.src;
  }
}

function showPictures() {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-pic]')) {
    const got = state.pics.get(el.dataset.pic);
    if (!got) {
      requestList(el.dataset.pic);
      continue;
    }
    if (got === 'loading' || el.firstChild) continue;
    const pics = got[el.dataset.entry];
    if (!pics || !pics.length) { el.classList.add('fl-thumb-none'); continue; }
    pics.forEach((p, i) => {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      if (p.caption) img.title = p.caption;
      if (i === 0) img.classList.add('on');
      img.onerror = () => {
        const wasOn = img.classList.contains('on');
        img.remove();
        if (!el.querySelector('img')) el.classList.add('fl-thumb-none');
        else if (wasOn) el.querySelector('img').classList.add('on');
        if (el.querySelectorAll('img').length < 2) el.removeAttribute('data-multi');
      };
      el.appendChild(img);
      loadPicture(img, picUrl(el.dataset.pic, el.dataset.entry, p), i === 0);
    });
    if (pics.length > 1) el.dataset.multi = '1';
    // click / Enter: all of the entry's pictures in a lightbox
    el.dataset.act = 'pics';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.removeAttribute('aria-hidden');
    el.setAttribute('aria-label', `Show the pictures (${pics.length})`);
  }
  startPictureCycle();
}

/* ------------------------------------------------------------ lightbox */

// <dialog> with the entry's pictures, large: previous / next (buttons, arrow
// keys), counter, caption; Esc, the close button or a click outside closes it
const lb = { dialog: null, pics: [], i: 0, title: '' };

function picUrl(sourceId, entryId, p) {
  return p.url || `/api/v1/media/${encodeURIComponent(sourceId)}/${encodeURIComponent(entryId)}/${p.n}`;
}

function openLightbox(sourceId, entryId, title) {
  const got = state.pics.get(sourceId);
  const pics = got && got !== 'loading' ? got[entryId] : null;
  if (!pics || !pics.length) return;
  lb.pics = pics.map((p) => ({ src: picUrl(sourceId, entryId, p), caption: p.caption || '' }));
  lb.i = 0;
  lb.title = title;
  if (!lb.dialog) {
    lb.dialog = document.createElement('dialog');
    lb.dialog.className = 'fl-lb';
    lb.dialog.innerHTML = `
      <div class="fl-lb-top"><span class="fl-lb-title" data-lb="title"></span><span class="mono hint" data-lb="count"></span>
        <button type="button" class="fl-lb-close" data-lb="close" aria-label="Close">✕</button></div>
      <div class="fl-lb-stage">
        <button type="button" class="fl-lb-nav" data-lb="prev" aria-label="Previous picture">‹</button>
        <img data-lb="img" alt="">
        <button type="button" class="fl-lb-nav" data-lb="next" aria-label="Next picture">›</button>
      </div>
      <p class="fl-lb-cap" data-lb="cap"></p>`;
    lb.dialog.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lb]');
      if (e.target === lb.dialog || (b && b.dataset.lb === 'close')) lb.dialog.close();     // a click on the backdrop
      else if (b && b.dataset.lb === 'prev') stepLightbox(-1);
      else if (b && b.dataset.lb === 'next') stepLightbox(1);
    });
    lb.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { stepLightbox(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { stepLightbox(1); e.preventDefault(); }
    });
    document.body.appendChild(lb.dialog);
  }
  showLightbox();
  if (!lb.dialog.open) lb.dialog.showModal();
}

function stepLightbox(d) {
  if (lb.pics.length < 2) return;
  lb.i = (lb.i + d + lb.pics.length) % lb.pics.length;
  showLightbox();
}

function showLightbox() {
  const q = (k) => lb.dialog.querySelector(`[data-lb="${k}"]`);
  const p = lb.pics[lb.i];
  q('img').src = p.src;
  q('img').alt = p.caption || lb.title;
  q('title').textContent = lb.title;
  q('count').textContent = lb.pics.length > 1 ? `${lb.i + 1} / ${lb.pics.length}` : '';
  q('cap').textContent = p.caption;
  q('prev').hidden = q('next').hidden = lb.pics.length < 2;
  lb.dialog.setAttribute('aria-label', `Pictures of ${lb.title}`);
}

// Menu disks: an entry with several pictures (one per game) cross-fades
// through them. One timer for the whole page; only thumbnails on screen
// move; off when the browser asks for reduced motion.
const CYCLE_MS = 2600;
let cycleTimer = null;
function startPictureCycle() {
  if (cycleTimer || !root || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  cycleTimer = setInterval(() => {
    if (!root) { clearInterval(cycleTimer); cycleTimer = null; return; }
    if (document.hidden) return;
    const h = window.innerHeight;
    for (const el of root.querySelectorAll('.fl-thumb[data-multi]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > h) continue;
      const imgs = [...el.querySelectorAll('img')];
      const cur = imgs.findIndex((x) => x.classList.contains('on'));
      const next = imgs[(cur + 1) % imgs.length];
      if (!next.complete || !next.naturalWidth) continue;      // not loaded yet: wait
      imgs.forEach((x) => x.classList.toggle('on', x === next));
    }
  }, CYCLE_MS);
}

function requestList(sourceId) {
  if (state.pics.has(sourceId)) return;
  state.pics.set(sourceId, 'loading');
  if (!worker) {
    try {
      worker = new Worker(new URL('../listworker.js', import.meta.url));
    } catch (e) { return; }
    worker.onmessage = (ev) => {
      if (!state) return;
      const { sourceId: id, pics, error } = ev.data;
      if (error) console.warn(`library pictures of ${id}: ${error}`);
      state.pics.set(id, pics || {});
      showPictures();
    };
  }
  worker.postMessage({ sourceId });
}

function renderRows() {
  const r = state.result;
  const rows = $('rows');
  rows.setAttribute('aria-busy', 'false');

  if (!r || r.status === 'downloading') {
    rows.innerHTML = '<div class="fl-empty">Fetching the image list…</div>';
  } else if (!r.results.length) {
    rows.innerHTML = `<div class="fl-empty">${state.q ? 'Nothing matches your search.' : 'The library is empty: add a source under Config → Floppy library.'}</div>`;
  } else {
    rows.innerHTML = r.results.map(row).join('');
    showPictures();
  }

  const total = r ? r.total || 0 : 0;
  const pages = r ? r.pages || 0 : 0;
  const count = r && r.status !== 'downloading'
    ? `${r.results.length} shown · ${total.toLocaleString()} image${total === 1 ? '' : 's'}${state.q ? ` matching “${state.q}”` : ''}`
    : '';
  for (const n of ['', '2']) {
    $(`count${n}`).textContent = count;
    $(`pageinfo${n}`).textContent = pages ? `${state.page + 1} / ${pages}` : '';
    $(`prev${n}`).disabled = state.page <= 0;
    $(`next${n}`).disabled = !pages || state.page >= pages - 1;
  }
}

// One game on the image: its name is the title (readable case and punctuation)
function titleFor(image, games) {
  return games && games.length === 1 ? games[0] : prettyName(image);
}

function row(it) {
  const allGames = it.games || [];
  const name = it.title || titleFor(it.image, allGames);
  const disk = it.disk && it.disk.count > 1 ? `Disk ${it.disk.index} of ${it.disk.count}${it.disk.label ? ` · ${it.disk.label}` : ''}` : '';
  const pic = it.sourceId && sourceFormat(it.sourceId) === 'json'
    ? `<span class="fl-thumb" data-pic="${esc(it.sourceId)}" data-entry="${esc(it.entryId || '')}" data-title="${esc(name)}" aria-hidden="true"></span>` : '';
  const games = allGames.length === 1 ? [] : allGames;
  const pend = state.pending.get(it.image);
  const chips = games.length
    ? `<ul class="fl-chips" aria-label="Games on ${esc(name)}">${games.map((g) => `<li class="chip${highlight(g) ? ' chip-hit' : ''}">${esc(g)}</li>`).join('')}</ul>`
    : allGames.length ? '' : '<span class="hint">No game list in metadata</span>';
  const inSlots = new Set(it.inSlots || []);
  const gone = it.available === false;                 // its folder's drive went away
  const status = gone ? '<span class="tag">Not attached</span>' : pend
    ? `<span class="tag tag-accent">Downloading${pend.percent ? ` ${pend.percent}%` : '…'}</span>`
    : it.local ? '' : it.haveIt ? '<span class="tag">Downloaded</span>' : '';
  const verb = it.haveIt ? 'Insert' : 'Download + insert';
  return `<div role="listitem" class="fl-row${gone ? ' fl-row-gone' : ''}"${gone ? ' aria-disabled="true"' : ''}>
      <div class="fl-row-main">
        <div class="fl-row-title">${pic}<span class="fl-row-name">${esc(name)}</span>${disk ? `<span class="tag">${esc(disk)}</span>` : ''}<span class="mono hint">${esc(it.image)}</span></div>
        ${chips}
      </div>
      <div class="fl-row-tags">
        ${it.source ? `<span class="tag">${esc(it.source)}</span>` : ''}
        ${status}
      </div>
      <div class="fl-row-insert">
        ${!it.haveIt && !it.local && !gone ? `<button type="button" class="btn btn-secondary fl-dl" data-act="download" data-image="${esc(it.image)}" aria-label="Download ${esc(name)} without inserting it"${pend ? ' disabled' : ''}>Download</button>` : ''}
        <span class="mono hint" aria-hidden="true">${it.haveIt ? 'INSERT →' : 'GET →'}</span>
        ${[0, 1, 2].map((i) => `<button type="button" class="fl-target${inSlots.has(i) ? ' in' : ''}" data-act="insert" data-image="${esc(it.image)}" data-have="${it.haveIt ? 1 : 0}" data-slot="${i}" aria-label="${verb} ${esc(name)} into slot ${i + 1}"${inSlots.has(i) ? ' aria-pressed="true"' : ''}${pend || gone ? ' disabled' : ''}>${i + 1}</button>`).join('')}
      </div>
    </div>`;
}

async function insert(image, slot, haveIt) {
  try {
    if (!haveIt) {
      if (state.sources && !state.sources.storage) {
        say('No storage for downloads: plug in a USB drive or set up the shared drive.');
        return;
      }
      const d = await api(`/api/v1/download/download?${qs({ image })}`);
      if (d.status !== 'ok') throw new Error(d.reason || 'download refused');
      state.pending.set(image, { slot, percent: 0, since: Date.now() });
      say(`Downloading ${image}; it goes into slot ${slot + 1} when it's done.`);
      renderRows();
      pollSlotsSoon();
      return;
    }
    const r = await api(`/api/v1/download/insert?${qs({ image, slot })}`);
    if (r.status !== 'ok') throw new Error(r.reason || 'insert refused');
    say(`${image} is in slot ${slot + 1}.`);
    pollSlotsSoon();
    search();
  } catch (e) { say(`Couldn't insert ${image}: ${e.message}`); }
}

// while downloads are pending: progress, then insert into the chosen slot
// The Pi has no clock battery: until the app's time sync worked the date is
// 1970 and HTTPS downloads fail (certificates "not yet valid")
function showClock(st) {
  if (!root) return;
  const t = st && st.hw && st.hw.time;
  const year = t ? parseInt(t.slice(0, 4), 10) : NaN;
  $('clock').hidden = !(year && year < 2020);
}

// Download only (no slot): the image lands in the download folder
async function downloadOnly(image) {
  try {
    const d = await api(`/api/v1/download/download?${qs({ image })}`);
    if (d.status !== 'ok') throw new Error(d.reason || 'download refused');
    state.pending.set(image, { slot: -1, percent: 0, since: Date.now() });
    say(`Downloading ${image}…`);
    renderRows();
    pollSlotsSoon();
  } catch (e) { say(`Couldn't download ${image}: ${e.message}`); }
}

async function checkDownloads() {
  let list = [];
  try {
    const d = await api('/api/v1/download/downloading');
    list = d.downloading || [];
  } catch (e) { return; }

  for (const [image, p] of state.pending) {
    const running = list.find((x) => x.fileName === image);
    if (running) {
      p.percent = running.progress;
      continue;
    }
    if (Date.now() - p.since < 1500) continue;      // not started yet
    state.pending.delete(image);
    if (p.slot < 0) {                               // download only: did it arrive?
      try {
        const r = await api(`/api/v1/library/search?${qs({ q: image.replace(/\.[^.]+$/, ''), size: 20 })}`);
        const hit = (r.results || []).find((x) => x.image === image);
        say(hit && hit.haveIt ? `${image} downloaded.` : `Download of ${image} failed.`);
      } catch (e) { say(`Download of ${image} failed.`); }
      continue;
    }
    // finished (or failed): if we have it now, insert it
    try {
      const r = await api(`/api/v1/download/insert?${qs({ image, slot: p.slot })}`);
      if (r.status === 'ok') say(`${image} downloaded and in slot ${p.slot + 1}.`);
      else say(`Download of ${image} failed.`);
    } catch (e) { say(`Download of ${image} failed.`); }
  }
  search();
}

/* --------------------------------------------------------------- clicks */

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'select') selectSlot(Number(b.dataset.slot));
  else if (act === 'eject') ejectSlot(Number(b.dataset.slot));
  else if (act === 'own') insertOwn(Number(b.dataset.own), b.dataset.name);
  else if (act === 'pics') openLightbox(b.dataset.pic, b.dataset.entry, b.dataset.title);
  else if (act === 'download') downloadOnly(b.dataset.image);
  else if (act === 'insert') insert(b.dataset.image, Number(b.dataset.slot), b.dataset.have === '1');
  else if (act === 'source') { state.source = b.dataset.id; state.page = 0; renderSources(); search(); }
}
