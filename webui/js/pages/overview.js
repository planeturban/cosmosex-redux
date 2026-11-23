// Overview: live status of the CosmosEx (stage 7.2), from /api/v1/status
// (ce-atari patch 0010), polled every 2 s while this page is shown.

import { subscribe } from '../status.js';

let unsubscribe = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function mount(el) {
  el.innerHTML = `
    <header class="page-head">
      <div>
        <p class="eyebrow" data-ov="eyebrow">Connecting…</p>
        <h1>Overview</h1>
      </div>
      <div class="actions">
        <a class="btn btn-primary" href="#/floppy">Insert floppy</a>
        <a class="btn btn-secondary" href="#/remote">Open remote</a>
      </div>
    </header>

    <section class="ov-section" aria-labelledby="ov-chips">
      <div class="section-head">
        <h2 id="ov-chips">Chips &amp; interfaces</h2>
        <span class="mono hint">LIVE · 2 s</span>
      </div>
      <div class="stat-grid" data-ov="chips" aria-live="off"></div>
    </section>

    <div class="ov-columns">
      <section class="panel ov-main" aria-labelledby="ov-acsi">
        <div class="section-head">
          <h2 id="ov-acsi" data-ov="bus-title">ACSI bus</h2>
          <a class="link-action" href="#/harddisk">Hard disk →</a>
        </div>
        <div class="id-grid" data-ov="ids"></div>
        <h3 class="ov-sub">Drives on the ST</h3>
        <ul class="drive-list" data-ov="drives"></ul>
      </section>

      <div class="ov-side">
        <section class="panel" aria-labelledby="ov-fdd">
          <div class="section-head">
            <h2 id="ov-fdd">Floppy slots</h2>
            <a class="link-action" href="#/floppy">Manage →</a>
          </div>
          <ol class="slot-list" data-ov="slots"></ol>
        </section>

        <section class="panel" aria-labelledby="ov-io">
          <h2 id="ov-io">Inputs &amp; network</h2>
          <dl class="kv" data-ov="io"></dl>
        </section>

        <section class="panel panel-accent" aria-labelledby="ov-tools">
          <h2 id="ov-tools" class="tight">ST tools</h2>
          <p class="hint">Copy these to the ST to configure and boot from CosmosEx.</p>
          <ul class="download-list">
            ${tool('CE_CONF.TOS', '/app/debug/get_ceconf_prg', 'Config tool')}
            ${tool('CE_DD.PRG', '/app/debug/get_cedd', 'Translated-drive driver')}
            ${tool('CE_CONF.ST', '/app/debug/get_ceconf_msa', 'Config tool on a floppy image')}
            ${tool('CE_CONF.ZIP', '/app/debug/get_ceconf_tar', 'All tools, zipped')}
          </ul>
        </section>
      </div>
    </div>

    <footer class="ov-foot mono">
      <span data-ov="versions">—</span>
      <span><a href="/app/status/">Status report</a> · <a href="/app/debug/">Debug report</a> · <a href="/credits.html">Credits</a></span>
    </footer>`;

  const q = (name) => el.querySelector(`[data-ov="${name}"]`);
  unsubscribe = subscribe((s) => render(s, q), { fast: true });
}

export function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

function tool(name, href, what) {
  return `<li><a href="${href}" download><span class="mono">${name}</span><span class="sr-only"> — ${what}</span><span class="link-action" aria-hidden="true">Download ↓</span></a></li>`;
}

/* ---------------------------------------------------------------- render */

function render(s, q) {
  const hw = s.hw || {};
  q('eyebrow').textContent = [
    hw.version ? `HW v${hw.version}` : null,
    hw.interface,
    rpiShort(hw.rpi),
    hw.uptime_s != null ? `UP ${duration(hw.uptime_s)}` : null,
  ].filter(Boolean).join(' · ');

  q('chips').innerHTML = [
    chip('Hans chip', s.chips?.hans, true),
    chip('Franz chip', s.chips?.franz, true),
    chip('Hard drive IF', s.chips?.hdd_if),
    chip('Floppy IF', s.chips?.floppy_if),
    chip('IKBD from ST', s.chips?.ikbd_st),
    chip('IKBD from USB', s.chips?.ikbd_usb),
  ].join('');

  const bus = hw.interface === 'SCSI' ? 'SCSI' : 'ACSI';
  q('bus-title').textContent = `${bus} bus`;
  // The translated-drive driver (ce_dd) on that ID serves all translated drives
  const letters = (s.drives || []).map((d) => d.letter).join(' ');
  q('ids').innerHTML = (s.acsi || []).map((d) => idTile(d, letters)).join('');

  const drives = s.drives || [];
  q('drives').innerHTML = drives.length
    ? drives.map(driveRow).join('')
    : '<li class="drive-empty hint">No drives yet: plug in a USB drive or set up the shared drive.</li>';

  q('slots').innerHTML = [0, 1, 2].map((i) => slotRow(i, s.floppy)).join('');
  q('io').innerHTML = inputsAndNetwork(s);

  const v = s.versions || {};
  q('versions').textContent = `ce_main_app ${v.app || '—'} · hans fw ${v.hans || '—'} · franz fw ${v.franz || '—'} · xilinx ${v.xilinx || 'unknown'}`;
}

function rpiShort(model) {
  if (!model) return null;
  const m = model.replace(/^Raspberry Pi\s*/i, 'RPI ').replace(/\s*Rev.*$/i, '')
    .replace(/\s*Model\s*/i, '').replace(/\s*Plus/i, '+');
  return m.toUpperCase();
}

function duration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}D ${h}H`;
  if (h) return `${h}H ${m}M`;
  return `${m}M`;
}

function ago(sec) {
  if (sec == null) return 'never';
  if (sec < 1) return 'just now';
  if (sec < 60) return `${sec} s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  return `${Math.floor(sec / 3600)} h ago`;
}

// Chips (Hans, Franz) answer the app all the time: no answer is a problem.
// Interfaces are only busy when the ST uses them: idle is normal.
function chip(name, c, isChip = false) {
  let state, dot;
  if (!c || !c.ok) {
    state = isChip ? 'No answer' : 'Idle';
    dot = isChip ? 'bad' : 'dim';
  } else if (isChip) {
    state = 'OK'; dot = 'ok';
  } else if (c.ago_s < 10) {
    state = 'Active'; dot = 'ok';
  } else {
    state = 'Idle'; dot = 'dim';
  }
  const detail = !c || !c.ok ? (isChip ? 'never answered' : 'no activity yet') : `${c.sign} · ${ago(c.ago_s)}`;
  return `<div class="stat">
      <div class="stat-label mono">${esc(name)}</div>
      <div class="stat-state"><span class="dot dot-${dot}" aria-hidden="true"></span>${esc(state)}</div>
      <div class="stat-detail mono">${esc(detail)}</div>
    </div>`;
}

const MODE_LABEL = { off: 'Off', translated: 'Translated', sd: 'SD card', raw: 'Raw' };

function idTile(d, letters) {
  const off = d.mode === 'off';
  let detail = '—';
  if (d.mode === 'translated') detail = letters || 'ce_dd';
  else if (!off && d.media) detail = d.media;
  else if (!off) detail = 'no media';
  return `<div class="id-tile${off ? ' off' : ''}">
      <div class="mono id-num">ID ${d.id}</div>
      <div class="id-mode">${esc(MODE_LABEL[d.mode] || d.mode)}</div>
      <div class="mono id-detail" title="${esc(detail)}">${esc(detail)}</div>
    </div>`;
}

function size(mb) {
  if (mb == null) return '—';
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function driveRow(d) {
  const src = d.source || '';
  let source = src, mode = 'translated';
  let m;
  if (/^config drive/.test(src)) { source = 'Config drive'; mode = 'read-only'; }
  else if ((m = src.match(/^shared drive,\s*(.*)$/))) source = `Shared · ${m[1]}`;
  else if ((m = src.match(/^(.*) \(USB drive\) - device: (.*)$/))) source = `USB · ${m[1]}`;
  else if ((m = src.match(/^USB drive - device: (.*)$/))) source = `USB · ${m[1]}`;
  return `<li>
      <span class="mono drive-letter">${esc(d.letter)}</span>
      <span class="drive-source">${esc(source)}</span>
      <span class="hint">${esc(mode)}</span>
      <span class="mono drive-free">${d.free_mb != null ? `${esc(size(d.free_mb))} free` : '—'}</span>
    </li>`;
}

function slotRow(i, f = {}) {
  const name = f.slots ? f.slots[i] : null;
  const active = f.active === i;
  const meta = !name ? 'Drop an image or pick from library' : active ? 'Selected · in the drive' : 'Inserted';
  return `<li class="slot${active ? ' active' : ''}${name ? '' : ' empty'}">
      <span class="slot-num mono" aria-hidden="true">${i + 1}</span>
      <div class="slot-text">
        <div class="slot-name"><span class="sr-only">Slot ${i + 1}: </span>${esc(name || 'Empty')}</div>
        <div class="slot-meta">${esc(meta)}</div>
      </div>
    </li>`;
}

function inputsAndNetwork(s) {
  const i = s.inputs || {};
  const n = s.network || {};
  const row = (k, v) => `<dt>${esc(k)}</dt><dd class="${v == null ? 'none' : ''}">${esc(v ?? 'none')}</dd>`;
  const net = (x, disabled) => {
    if (disabled) return null;
    if (!x || !x.up) return 'no connection';
    return `${x.ip} · ${x.dhcp ? 'DHCP' : 'static'}`;
  };
  const wlan = n.wifi_enabled === false ? 'disabled' : net(n.wlan0);
  return [
    row('Keyboard', i.keyboard),
    row('Mouse', i.mouse),
    row('Joystick 1', i.joy1),
    row('Joystick 2', i.joy2),
    `<dt>eth0</dt><dd class="${n.eth0?.up ? 'mono' : 'none'}">${esc(net(n.eth0))}</dd>`,
    `<dt>wlan0</dt><dd class="${n.wlan0?.up ? 'mono' : 'none'}">${esc(wlan)}</dd>`,
  ].join('');
}
