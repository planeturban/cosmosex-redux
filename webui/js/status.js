// Shared status poller: GET /api/v1/status (ce-atari patch 0010).
// Polls every 5 s (2 s while a page asks for it, e.g. Overview), pauses while
// the tab is hidden, and backs off up to 10 s when the CosmosEx doesn't
// answer (with the "Lost connection" bar). Keeps the shell's status bits
// (sidebar Hans/Franz/A:, app version, connection dot, hostname) current;
// pages subscribe for the full object.

const URL_STATUS = '/api/v1/status';
const SLOW = 5000;
const FAST = 2000;
const MAX_BACKOFF = 10000;

let last = null;
let timer = null;
let failures = 0;
let fastUsers = 0;
const listeners = new Set();

export function latest() { return last; }

// subscribe(fn, {fast}) → unsubscribe function. fn(status) is called with the
// last known status right away (if any) and after every poll.
export function subscribe(fn, { fast = false } = {}) {
  listeners.add(fn);
  if (fast) fastUsers++;
  if (last) fn(last);
  schedule(0);
  return () => {
    listeners.delete(fn);
    if (fast) fastUsers = Math.max(0, fastUsers - 1);
  };
}

async function fetchJSON(url, timeoutMs = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let r;
    try {
      r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    } catch (e) {
      // the request itself failed (not: no answer in time): once more, on a
      // new connection (a connection the server had closed, taken for open)
      if (ctl.signal.aborted) throw e;
      r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(poll, ms);
}

async function poll() {
  if (document.hidden) return; // resumed by visibilitychange
  try {
    last = await fetchJSON(URL_STATUS);
    failures = 0;
    setConnection(true);
    updateShell(last);
    for (const fn of listeners) {
      try { fn(last); } catch (e) { console.error(e); }
    }
  } catch (e) {
    failures++;
    // one missed answer isn't a lost connection (a busy browser, a slow
    // moment on the network): say so when the next one is missed too
    if (failures >= 2) setConnection(false);
  }
  const interval = failures
    ? Math.min(MAX_BACKOFF, 2000 * failures)
    : (fastUsers > 0 ? FAST : SLOW);
  schedule(interval);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) schedule(0);
});

/* ------------------------------------------------------------- the shell */

function setConnection(ok) {
  const bar = document.querySelector('.conn-bar');
  if (bar) bar.hidden = ok;
  for (const d of document.querySelectorAll('[data-conn-dot]')) {
    d.classList.toggle('dot-ok', ok);
    d.classList.toggle('dot-bad', !ok);
  }
  for (const t of document.querySelectorAll('[data-conn-text]')) t.textContent = ok ? 'ONLINE' : 'OFFLINE';
}

function setText(sel, text) {
  for (const el of document.querySelectorAll(sel)) el.textContent = text;
}

function setDot(name, state) { // state: 'ok' | 'bad' | 'dim'
  for (const d of document.querySelectorAll(`[data-status-dot="${name}"]`)) {
    d.classList.remove('dot-ok', 'dot-bad', 'dot-dim');
    d.classList.add(`dot-${state}`);
  }
}

function updateShell(s) {
  for (const chip of ['hans', 'franz']) {
    const c = s.chips && s.chips[chip];
    const ok = c && c.ok;
    setText(`[data-status="${chip}"]`, ok ? 'OK' : 'NO ANSWER');
    setDot(chip, ok ? 'ok' : 'bad');
  }
  const f = s.floppy || {};
  const active = f.active != null && f.slots ? f.slots[f.active] : null;
  setText('[data-status="floppy"]', active || 'empty');
  setText('[data-status="version"]', (s.versions && s.versions.app) || '—');
  if (s.hw && s.hw.hostname) setText('[data-hostname]', s.hw.hostname);
}

// Start polling for the shell even before a page subscribes
schedule(0);
