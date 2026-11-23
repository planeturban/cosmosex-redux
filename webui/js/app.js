// CosmosEx web UI: app shell (router, theme switch, drawer, page switcher, swipe).
// Pages are ES modules in js/pages/<id>.js exporting mount(container) and,
// optionally, unmount(), so a page can stop its polling when left.

import './auth.js';   // login: 401 -> login page (first: before anything calls the API)
import './status.js'; // keeps the sidebar status and connection indicator current
import './restart.js'; // Restart in the menu

const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'floppy', label: 'Floppy' },
  { id: 'harddisk', label: 'Hard disk' },
  { id: 'files', label: 'Files' },
  { id: 'remote', label: 'Remote' },
  { id: 'config', label: 'Config' },
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const narrowQuery = window.matchMedia('(max-width: 759px)');

/* ---------------------------------------------------------------- theme */

const THEME_KEY = 'ce-theme';

function storedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch (e) {
    return 'auto';
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const b of $$('[data-theme-set]')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme));
  }
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch (e) { /* private mode: theme just isn't remembered */ }
}

/* --------------------------------------------------------------- drawer */

const menuBtn = $('.menu-btn');
const drawer = $('#drawer');

function setDrawer(open) {
  drawer.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}

/* --------------------------------------------------------------- router */

const main = $('#page');
let current = -1;
let currentModule = null;
let loadToken = 0;

function pageIndex(hash) {
  const id = (hash || '').replace(/^#\/?/, '').split(/[/?]/)[0];
  const i = PAGES.findIndex((p) => p.id === id);
  return i < 0 ? 0 : i;
}

async function show(index, { focus = false } = {}) {
  const page = PAGES[index];
  const dir = current < 0 || index === current ? null : index > current ? 'next' : 'prev';
  const token = ++loadToken;

  if (currentModule && currentModule.unmount) {
    try { currentModule.unmount(); } catch (e) { console.error(e); }
  }
  current = index;
  updateShell(index);

  let mod;
  try {
    mod = await import(`./pages/${page.id}.js`);
  } catch (e) {
    console.error(e);
    mod = null;
  }
  if (token !== loadToken) return; // a newer navigation won

  const inner = document.createElement('div');
  inner.className = 'page-inner';
  if (dir) inner.dataset.anim = dir;
  main.replaceChildren(inner);
  currentModule = mod;
  if (mod && mod.mount) {
    mod.mount(inner);
  } else {
    inner.innerHTML = '<p class="hint">This page could not be loaded.</p>';
  }
  document.title = `${page.label} · CosmosEx redux`;
  if (focus) main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function updateShell(index) {
  const page = PAGES[index];
  for (const a of $$('[data-page]')) {
    if (a.dataset.page === page.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('[data-page-title]').textContent = page.label;
  $('[data-page-pos]').textContent = `${index + 1}/${PAGES.length}`;

  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];
  const prevBtn = $('[data-pager="prev"]');
  const nextBtn = $('[data-pager="next"]');
  prevBtn.disabled = !prev;
  nextBtn.disabled = !next;
  $('[data-pager-label="prev"]').textContent = prev ? prev.label : '';
  $('[data-pager-label="next"]').textContent = next ? next.label : '';
  prevBtn.setAttribute('aria-label', prev ? `Previous page: ${prev.label}` : 'Previous page');
  nextBtn.setAttribute('aria-label', next ? `Next page: ${next.label}` : 'Next page');
}

function go(index) {
  if (index < 0 || index >= PAGES.length) return;
  location.hash = `#/${PAGES[index].id}`;
}

/* ---------------------------------------------------------------- swipe */

// Narrow screens: horizontal drag >= 60 px with |dx| > 1.5·|dy| changes page.
// Drags starting in [data-noswipe] (screencast, keyboard) or form fields don't.
let swipe = null;

main.addEventListener('pointerdown', (e) => {
  if (!narrowQuery.matches || e.pointerType === 'mouse') { swipe = null; return; }
  if (e.target.closest('[data-noswipe], input, textarea, select')) { swipe = null; return; }
  swipe = { x: e.clientX, y: e.clientY };
});
main.addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) >= 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(current + (dx < 0 ? 1 : -1));
});
main.addEventListener('pointercancel', () => { swipe = null; });

/* ------------------------------------------------------------------ init */

for (const b of $$('[data-theme-set]')) b.addEventListener('click', () => applyTheme(b.dataset.themeSet));
applyTheme(storedTheme());

menuBtn.addEventListener('click', () => setDrawer(drawer.hidden));
// Also when the link is the current page (no hashchange then)
for (const a of $$('a', drawer)) a.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !drawer.hidden) { setDrawer(false); menuBtn.focus(); }
});
narrowQuery.addEventListener('change', () => { if (!narrowQuery.matches) setDrawer(false); });

$('[data-pager="prev"]').addEventListener('click', () => go(current - 1));
$('[data-pager="next"]').addEventListener('click', () => go(current + 1));

for (const el of $$('[data-hostname]')) el.textContent = location.hostname || 'cosmosex';

window.addEventListener('hashchange', () => {
  setDrawer(false);
  show(pageIndex(location.hash), { focus: true });
});
show(pageIndex(location.hash));
