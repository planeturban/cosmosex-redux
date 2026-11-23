// Restart the CosmosEx from the menu ([data-restart]): asks first (saying what
// a restart also does: start an installed update, stop a copy on the Files
// page; and "Try to reset the host": the ST is reset first, so nothing it
// writes is cut off by the CosmosEx going away), POST
// /api/v1/system/update/restart, then a "Restarting" overlay that waits for
// the CosmosEx to go away and come back, and reloads the page.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESET_KEY = 'ce.restart.resetSt';               // (the last choice, this browser only)
const lastReset = () => { try { return localStorage.getItem(RESET_KEY) === '1'; } catch (e) { return false; } };
const keepReset = (on) => { try { localStorage.setItem(RESET_KEY, on ? '1' : '0'); } catch (e) { /* private window */ } };

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// is the CosmosEx answering? (the login page needs no login; with app: its
// status too, which needs the app and, with the login on, a valid session)
async function answers(app = false) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(app ? '/api/v1/status' : `/login.html?alive=${Date.now()}`, { cache: 'no-store', signal: c.signal });
    clearTimeout(t);
    return r.ok || (app && r.status === 401);           // (logged out by the restart: the login page then)
  } catch (e) { return false; }
}

function dialog() {
  let d = document.querySelector('dialog[data-restart-dlg]');
  if (!d) {
    d = document.createElement('dialog');
    d.className = 'restart-dlg';
    d.setAttribute('data-restart-dlg', '');
    d.setAttribute('aria-labelledby', 'restart-dlg-h');
    document.body.appendChild(d);
  }
  return d;
}

function ask(sys, job) {
  const notes = [];
  if (sys && sys.staged) notes.push(`It then starts the installed update ${esc(sys.staged)} (tried once, kept if it works).`);
  if (job && job.state === 'running') notes.push(`A ${job.op === 'move' ? 'move' : 'copy'} on the Files page is running: it stops (the file being written is lost; the rest is there).`);
  const d = dialog();
  d.innerHTML = `<form method="dialog">
      <h2 id="restart-dlg-h">Restart the CosmosEx?</h2>
      <p>It's back in about a minute. Meanwhile the Atari has no CosmosEx drives, floppies or keyboard; save your work on the ST first.</p>
      ${notes.map((n) => `<p class="hint cf-warn">${n}</p>`).join('')}
      <label class="restart-reset"><input type="checkbox" data-restart-reset${lastReset() ? ' checked' : ''}> Try to reset the host</label>
      <p class="hint">The ST is reset first (as Ctrl+Alt+Del), so a write isn't cut off halfway by the CosmosEx going away. Works when the ST started from the CosmosEx (its driver running). Reset the ST again once the CosmosEx is back.</p>
      <div class="restart-btns"><button type="submit" class="btn btn-primary" value="yes">Restart</button><button type="submit" class="btn btn-secondary" value="no">Cancel</button></div>
    </form>`;
  return new Promise((resolve) => {
    d.onclose = () => {
      const resetSt = d.querySelector('[data-restart-reset]').checked;
      if (d.returnValue === 'yes') keepReset(resetSt);
      resolve(d.returnValue === 'yes' ? { resetSt } : null);
    };
    d.returnValue = '';
    d.showModal();
    d.querySelector('button[value="no"]').focus();
  });
}

function overlay(text, hint, error = false) {
  const d = dialog();
  d.innerHTML = `<h2 id="restart-dlg-h">${esc(text)}</h2><p class="hint${error ? ' cf-warn' : ''}" role="status">${esc(hint)}</p>
    ${error ? '<div class="restart-btns"><button type="button" class="btn btn-secondary" data-restart-close>Close</button></div>' : ''}`;
  d.oncancel = (e) => { if (!error) e.preventDefault(); };     // no Esc while it restarts
  const b = d.querySelector('[data-restart-close]');
  if (b) b.onclick = () => d.close();
  if (!d.open) d.showModal();
}

export async function restartCosmosEx() {
  const [sys, job] = await Promise.all([getJson('/api/v1/system/update'), getJson('/api/v1/files/job')]);
  const choice = await ask(sys, job);
  if (!choice) return;
  overlay('Restarting', choice.resetSt ? 'Resetting the ST, then restarting the CosmosEx…' : 'Asking the CosmosEx to restart…');
  let said = '';
  try {
    const r = await fetch('/api/v1/system/update/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice.resetSt ? { resetSt: true } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (j.resetSt === 'reset') said = 'The ST was reset. ';
    else if (j.resetSt === 'noanswer') said = 'The ST didn\'t answer (no CosmosEx driver running on it), so it wasn\'t reset. ';
  } catch (e) {
    if (!/fetch|network|load/i.test(e.message)) { overlay('Not restarted', e.message, true); return; }
    // (no answer: it may already be going down)
  }
  overlay('Restarting', `${said}Waiting for the CosmosEx to go down…`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && await answers()) await sleep(1500);         // still up: wait for the restart
  overlay('Restarting', `${said}Waiting for the CosmosEx to come back (about a minute)…`);
  // back: the app answering four times in a row, 6 s (after a start the
  // Ethernet link can drop once more: some switches renegotiate ~13 s after
  // the link comes up, seen on the CosmosEx with a Pi 3 B+)
  let good = 0;
  while (Date.now() - t0 < 300000) {
    await sleep(2000);
    good = (await answers(true)) ? good + 1 : 0;
    if (good >= 4) {
      overlay('Back', 'The CosmosEx is back: reloading the page…');
      await sleep(1000);
      location.reload();
      return;
    }
  }
  overlay('Not back yet', 'The CosmosEx hasn\'t answered for five minutes. Check its screen (HDMI), or switch it off and on.', true);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-restart]');
  if (!b) return;
  e.preventDefault();
  restartCosmosEx();
});
