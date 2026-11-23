// Config (stage 7.5): the device settings as forms, on GET/PUT
// /api/v1/settings/<section> (ce-atari patch 0012) and the library sources
// on GET/PUT /api/v1/library/sources (patch 0011). The same settings and
// checks as CE_CONF.TOS on the Atari; the server validates again.
//
// Each section knows how to render its data and read it back from the
// form. A section is "dirty" when what the form says differs from what
// was loaded; Save sends each dirty section on its own, in order, and
// shows problems in the section they belong to.

import { latest } from '../status.js';
import { ZONES } from '../timezones.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let root = null;
let st = null;           // { saved: {section: data}, library: {...}, errors: {}, warnings: {} }
let observer = null;

// The sections in groups, in the order of the menu and of the page: what the
// ST uses first, then the network, then the CosmosEx itself.
const GROUPS = [
  { label: 'Atari', items: [
    { id: 'floppy', label: 'Floppy drive' },
    { id: 'library', label: 'Floppy library' },
    { id: 'ikbd', label: 'Keyboard & joysticks' },
    { id: 'other', label: 'Clock & screen' },
  ] },
  { label: 'Network', items: [
    { id: 'network', label: 'Network' },
    { id: 'shared', label: 'Shared drive' },
    { id: 'storageshare', label: 'Storage sharing' },
    { id: 'weblogin', label: 'Web login' },
  ] },
  { label: 'System', items: [
    { id: 'software', label: 'Software & update' },
    { id: 'backup', label: 'Backup & restore' },
    { id: 'experimental', label: 'Experimental' },
  ] },
];
const NAV = GROUPS.flatMap((g) => g.items);

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
  let body = null;
  try { body = await r.json(); } catch (e) { /* empty or not JSON */ }
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
}

const putJson = (url, data) => api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/* ---------------------------------------------------------------- mount */

export function mount(el) {
  root = el;
  st = { saved: null, library: null, errors: {}, warnings: {}, saving: false, savedNote: '' };
  el.innerHTML = `
    <div class="cf">
      <nav class="cf-nav" aria-label="Settings sections">
        <p class="eyebrow">CE_CONF · Web</p>
        <h1>Config</h1>
        ${GROUPS.map((g) => `<p class="cf-nav-group">${esc(g.label)}</p>
        <div class="cf-nav-links">${g.items.map((n) => `<a href="#/config/${n.id}" data-goto="${n.id}">${esc(n.label)}</a>`).join('')}</div>`).join('')}
        <p class="hint cf-classic">ACSI IDs, hard disk images and translated drives: <a href="#/harddisk">Hard disk</a>.</p>
        <p class="hint cf-classic">Something missing? The classic <a href="/config.html">config terminal</a> has every screen of CE_CONF.</p>
      </nav>
      <div class="cf-main" data-cf="main"><p class="hint">Loading settings…</p></div>
    </div>
    <div class="cf-bar" data-cf="bar" role="region" aria-label="Save changes">
      <span class="cf-bar-text mono" data-cf="bartext" role="status" aria-live="polite">ALL CHANGES SAVED</span>
      <div class="cf-bar-btns">
        <button type="button" class="btn btn-secondary" data-cf="cancel" disabled>Cancel</button>
        <button type="button" class="btn btn-primary" data-cf="save" disabled>Save</button>
      </div>
    </div>`;

  el.addEventListener('input', onEdit);
  el.addEventListener('change', onEdit);
  el.addEventListener('click', onClick);
  wifiEvents(el);
  el.addEventListener('keydown', (e) => {               // Enter in the update list's address: Save
    if (e.key !== 'Enter' || !e.target.matches || !e.target.matches('[data-sys-list]')) return;
    e.preventDefault();
    const b = root && root.querySelector('[data-sys="list"]:not([data-default])');
    if (b && !b.disabled) sysAction(b);
  });
  q('save').addEventListener('click', save);
  q('cancel').addEventListener('click', () => { renderAll(); updateBar(); });
  load();
}

export function unmount() {
  clearTimeout(sysTimer);
  clearTimeout(bkTimer);
  if (bkXhr) bkXhr.abort();
  if (sysXhr) sysXhr.abort();
  if (observer) observer.disconnect();
  observer = null;
  root = null;
}

const q = (name) => root.querySelector(`[data-cf="${name}"]`);

async function load() {
  try {
    const [saved, library, system, backup, flash, files, devmode] = await Promise.all([api('/api/v1/settings'), api('/api/v1/library/sources').catch(() => null),
      api('/api/v1/system/update').catch(() => null), api('/api/v1/system/backup').catch(() => null), api('/api/v1/system/flash').catch(() => null),
      api('/api/v1/files/options').catch(() => null), api('/api/v1/system/devmode').catch(() => null)]);
    if (!root) return;
    st.saved = saved;
    st.devmode = devmode;
    st.library = library;
    st.system = system;
    st.backup = backup;
    st.flash = flash;
    st.files = files;
    renderAll();
    updateBar();
    scrollToHashSection();
    pollSystem();                    // an update running, or a new system being tried
  } catch (e) {
    if (!root) return;
    q('main').innerHTML = `<section class="panel"><h2>Settings unavailable</h2><p>Couldn't load the settings: ${esc(e.message)}.</p>
      <p>The classic <a href="/config.html">config terminal</a> still works.</p></section>`;
  }
}

function scrollToHashSection() {
  const sub = location.hash.replace(/^#\/?config\/?/, '').split(/[/?]/)[0];
  if (['acsi', 'translated', 'hddimage'].includes(sub)) { location.replace('#/harddisk'); return; }   // moved there
  if (sub) document.getElementById(`cf-${sub}`)?.scrollIntoView({ block: 'start' });
}

/* ------------------------------------------------------------- sections */

const SECTIONS = {
  shared: {
    title: 'Shared drive (from a server)',
    hint: () => 'A folder on a NAS or PC that the ST sees as a drive. (The other way round, this CosmosEx\'s own storage for your computers: Storage sharing, below.)',
    status: (d) => d.mounted ? '<span class="cf-status"><span class="dot dot-ok" aria-hidden="true"></span>mounted</span>'
      : d.enabled ? '<span class="cf-status"><span class="dot dot-bad" aria-hidden="true"></span>not mounted</span>' : '',
    render(d) {
      return `${check('enabled', 'Use a shared drive', d.enabled)}
        <div class="cf-grid">
          <label class="field"><span>Protocol</span>
            <select class="select" data-key="protocol">
              <option value="smb"${d.protocol === 'smb' ? ' selected' : ''}>SMB / CIFS</option>
              <option value="nfs"${d.protocol === 'nfs' ? ' selected' : ''}>NFS</option>
            </select></label>
          ${text('address', 'Server (IP address)', d.address, { mono: true, placeholder: '192.168.1.10' })}
          ${text('path', 'Path on the server', d.path, { mono: true, placeholder: '/atari' })}
          ${text('username', 'User name', d.username, { autocomplete: 'off' })}
          ${text('password', 'Password', '', { type: 'password', placeholder: d.passwordSet ? '•••••• (set; type to change)' : 'none', autocomplete: 'new-password' })}
        </div>`;
    },
    read(sec) {
      const o = {
        enabled: chk(sec, 'enabled'), protocol: val(sec, 'protocol'), address: val(sec, 'address').trim(),
        path: val(sec, 'path').trim(), username: val(sec, 'username'),
      };
      const pw = val(sec, 'password');
      if (pw) o.password = pw;                       // empty: keep the stored one
      return o;
    },
  },

  floppy: {
    title: 'Floppy drive',
    render(d) {
      return `<div class="cf-checks">
          ${check('enabled', 'Floppy emulation on', d.enabled)}
          ${check('writeProtected', 'Write-protected', d.writeProtected)}
          ${check('soundEnabled', 'Drive sounds', d.soundEnabled)}
        </div>
        <div class="cf-radios">${radios('driveId', 'Emulated drive', [['0', 'Drive 0 (A:)'], ['1', 'Drive 1 (B:)']], String(d.driveId))}</div>
        <label class="field cf-src-wide"><span>Downloaded images go to</span>
          <input class="input mono" data-key="imageStorage" value="${esc(d.imageStorage || 'auto')}" list="cf-storage" spellcheck="false"></label>
        <datalist id="cf-storage">${storageChoices().map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        <p class="hint"><span class="mono">auto</span>: the first USB drive, else the shared drive, else the CosmosEx's storage (/storage/img_download). <span class="mono">shared</span>: the shared drive even with a USB drive attached. Or a folder: <span class="mono">share:/folder</span>, <span class="mono">usb:SERIAL:/folder</span>, <span class="mono">local:/folder</span>. When that place isn't there, downloads go to RAM (lost at power-off).
        ${d.imageStoragePath ? `Now: <span class="mono">${esc(d.imageStoragePath)}</span>${d.imageStorageKind === 'ram' ? ' (RAM)' : ''}.` : ''}</p>`;
    },
    read(sec) {
      return { enabled: chk(sec, 'enabled'), writeProtected: chk(sec, 'writeProtected'), soundEnabled: chk(sec, 'soundEnabled'), driveId: Number(radioVal(sec, 'driveId')),
        imageStorage: (sec.querySelector('[data-key="imageStorage"]')?.value || 'auto').trim() || 'auto' };
    },
  },

  storageshare: {
    title: 'Share this CosmosEx\'s storage',
    hint: () => 'The CosmosEx\'s own storage (/storage) as a network folder for your computers: NFS for Linux and macOS, SMB for Windows and macOS.',
    status: (d) => !d.available ? '' : !d.storageMounted ? '<span class="cf-status"><span class="dot dot-bad" aria-hidden="true"></span>/storage not mounted</span>'
      : `<span class="cf-status"><span class="dot ${d.nfs.running || d.smb.running ? 'dot-ok' : 'dot-off'}" aria-hidden="true"></span>${[d.nfs.running ? 'NFS' : '', d.smb.running ? 'SMB' : ''].filter(Boolean).join(' + ') || 'not shared'}</span>`,
    render(d) {
      if (!d.available) return '<p class="hint">Not available on this system.</p>';
      const host = d.hostname || 'cosmosex';
      const lines = (a) => esc((a || []).join('\n'));
      return `
        <fieldset class="cf-box">
          <legend>NFS</legend>
          ${check('nfsEnabled', 'Share /storage over NFS', d.nfs.enabled)}
          <div class="cf-radios">${radios('nfsAccess', 'Access', [['rw', 'Read and write'], ['ro', 'Read only']], d.nfs.access)}
          ${radios('nfsMap', 'Files are owned by', [['pi', 'the user pi, whoever connects (simple)'], ['users', 'each computer\'s own user (needs the same user ids everywhere)']], d.nfs.map)}</div>
          <label class="field cf-src-wide"><span>Computers allowed (one per line: an address, a network like 192.168.1.0/24, a host name, or * for everyone)</span>
            <textarea class="input mono" rows="3" data-key="nfsClients" spellcheck="false">${lines(d.nfs.clients)}</textarea></label>
          ${d.nfs.manual ? '<p class="hint">/etc/exports is written by hand (NFS_MANUAL=yes in /etc/ce-storageshare.conf): the settings above are not used for it.</p>' : ''}
          <p class="hint">Connect: macOS Finder → Go → Connect to Server → <span class="mono">nfs://${esc(host)}.local/storage</span>; Linux: <span class="mono">sudo mount -t nfs ${esc(host)}.local:/storage /mnt</span>.
          ${d.nfs.running && d.nfs.exports ? `Shared now: <span class="mono">${esc(d.nfs.exports.split(';').filter(Boolean).join(', '))}</span>.` : ''}</p>
        </fieldset>
        <fieldset class="cf-box">
          <legend>SMB (Windows file sharing)</legend>
          ${check('smbEnabled', 'Share /storage over SMB', d.smb.enabled)}
          <div class="cf-radios">${radios('smbAccess', 'Access', [['rw', 'Read and write'], ['ro', 'Read only']], d.smb.access)}
          ${radios('smbGuest', 'Log in', [['yes', 'No password (guest)'], ['no', 'User pi with a password']], d.smb.guest ? 'yes' : 'no')}</div>
          <div class="cf-grid">
            ${text('smbPassword', 'Password for the user pi', '', { type: 'password', placeholder: d.smb.passwordSet ? '•••••• (set; type to change)' : 'not set', autocomplete: 'new-password' })}
            ${text('smbWorkgroup', 'Workgroup', d.smb.workgroup, { mono: true })}
          </div>
          <label class="field cf-src-wide"><span>Computers allowed (one per line: an address, a network like 192.168.1.0/24, or * for everyone; no host names)</span>
            <textarea class="input mono" rows="3" data-key="smbClients" spellcheck="false">${lines(d.smb.clients)}</textarea></label>
          <p class="hint">Connect: Windows File Explorer → This PC → Map network drive → <span class="mono">\\\\${esc(host)}\\storage</span>; macOS Finder → Go → Connect to Server → <span class="mono">smb://${esc(host)}.local/storage</span> (guest: "Connect as Guest").</p>
        </fieldset>
        <p class="hint">Anyone allowed above can read (and with read and write, change) everything in /storage; NFS has no passwords. The default allows private networks (10.x, 172.16–31.x, 192.168.x): limit it to your own, e.g. 192.168.1.0/24.</p>
        <p class="hint">More: <a href="https://man7.org/linux/man-pages/man5/exports.5.html" target="_blank" rel="noopener noreferrer">exports(5)</a> (NFS shares, for hand-written /etc/exports),
          <a href="https://man7.org/linux/man-pages/man8/exportfs.8.html" target="_blank" rel="noopener noreferrer">exportfs(8)</a>,
          <a href="https://man7.org/linux/man-pages/man5/nfs.5.html" target="_blank" rel="noopener noreferrer">nfs(5)</a> (mount options on Linux),
          <a href="https://github.com/cifsd-team/ksmbd-tools/blob/master/ksmbd.conf.5.in" target="_blank" rel="noopener noreferrer">ksmbd.conf(5)</a> (the SMB server's settings),
          <a href="https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html" target="_blank" rel="noopener noreferrer">smb.conf(5)</a> (Samba; the same terms),
          <a href="https://support.apple.com/guide/mac-help/connect-mac-shared-computers-servers-mchlp1140/mac" target="_blank" rel="noopener noreferrer">macOS: connect to a server</a>.
          Settings file: <span class="mono">/etc/ce-storageshare.conf</span> (by hand: edit, then <span class="mono">sudo ce-storageshare apply</span>).</p>`;
    },
    read(sec) {
      if (!sec.querySelector('[data-key="nfsEnabled"]')) return {};
      const list = (key) => val(sec, key).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      const o = {
        nfs: { enabled: chk(sec, 'nfsEnabled'), access: radioVal(sec, 'nfsAccess'), map: radioVal(sec, 'nfsMap'), clients: list('nfsClients') },
        smb: { enabled: chk(sec, 'smbEnabled'), access: radioVal(sec, 'smbAccess'), guest: radioVal(sec, 'smbGuest') === 'yes', clients: list('smbClients'), workgroup: val(sec, 'smbWorkgroup').trim() },
      };
      const pw = val(sec, 'smbPassword');
      if (pw) o.smb.password = pw;                   // empty: keep the stored one
      return o;
    },
  },

  weblogin: {
    title: 'Web login',
    hint: () => 'A password for this web interface. Without a login, anyone on your network can change every setting.',
    status: (d) => d.insecureFile ? '<span class="cf-status"><span class="dot dot-bad" aria-hidden="true"></span>off: insecure.txt</span>'
      : d.enabled ? `<span class="cf-status"><span class="dot ${d.defaultPassword ? 'dot-bad' : 'dot-ok'}" aria-hidden="true"></span>${d.defaultPassword ? 'default password' : 'on'}</span>`
        : '<span class="cf-status"><span class="dot dot-bad" aria-hidden="true"></span>off</span>',
    render(d) {
      return `
        ${check('enabled', 'Ask for a password', d.enabled)}
        <div class="cf-grid">
          ${text('password', 'New password', '', { type: 'password', placeholder: d.defaultPassword ? 'still the default: set your own' : '(unchanged)', autocomplete: 'new-password' })}
          ${text('password2', 'New password again', '', { type: 'password', autocomplete: 'new-password' })}
        </div>
        ${d.defaultPassword && d.enabled ? '<p class="hint cf-warn">The password is still the default (thisisnotsecure): anyone who knows it can log in. Set your own.</p>' : ''}
        ${d.insecureFile ? '<p class="hint cf-warn">The login is off because the file <span class="mono">insecure.txt</span> is on the SD card\'s CosmosEx volume. Remove it (and restart) to use the login.</p>' : ''}
        <p class="hint">Forgot the password? Put an empty file <span class="mono">insecure.txt</span> on the SD card's <b>CosmosEx</b> volume (where the SSH keys go). A new password logs out every other browser.
          ${d.enabled && !d.insecureFile ? ' <a href="/login.html" data-logout-now>Log out now</a>.' : ''}</p>`;
    },
    check(sec) {
      const a = val(sec, 'password'), b = val(sec, 'password2');
      if (a !== b) return 'The two passwords are not the same.';
      if (a && a.length < 6) return 'The password must be at least 6 characters long.';
      return '';
    },
    read(sec) {
      const o = { enabled: chk(sec, 'enabled') };
      const a = val(sec, 'password');
      if (a && a === val(sec, 'password2')) o.password = a;
      return o;
    },
  },
  network: {
    title: 'Network',
    hint: () => 'Changing the address of the connection you use now disconnects this page: reconnect at the new address.',
    render(d) {
      // with DHCP the app reports 0.0.0.0: show empty fields instead
      const ip = (v) => (v === '0.0.0.0' ? '' : v);
      const iface = (key, label, x0, wifi) => {
        const x = { ...x0, address: ip(x0.address), netmask: ip(x0.netmask), gateway: ip(x0.gateway) };
        return `
        <fieldset class="cf-box" data-iface="${key}">
          <legend>${label}</legend>
          ${wifi ? check(`${key}.enabled`, 'Wi-Fi on', x.enabled) : ''}
          ${wifi ? `<div class="cf-grid cf-wifi-grid">
              <div class="field cf-wifi" data-wifi>
                <span id="cf-wifi-l">Network name (SSID)</span>
                <div class="cf-wifi-row">
                  <input class="input" type="text" data-key="${key}.ssid" data-wifi-in value="${esc(x.ssid ?? '')}" autocomplete="off" spellcheck="false"
                    role="combobox" aria-labelledby="cf-wifi-l" aria-autocomplete="list" aria-expanded="false" aria-controls="cf-wifi-list">
                  <button type="button" class="btn btn-secondary" data-wifi-scan>Scan</button>
                </div>
                <ul class="cf-wifi-list" id="cf-wifi-list" role="listbox" aria-label="Wireless networks in range" data-wifi-list hidden></ul>
                <span class="hint" data-wifi-note role="status"></span>
              </div>
              ${text(`${key}.psk`, 'WPA key', '', { type: 'password', placeholder: x.pskSet ? '•••••• (set; type to change)' : 'none', autocomplete: 'new-password' })}
            </div>` : ''}
          ${check(`${key}.dhcp`, 'Address from DHCP', x.dhcp)}
          <div class="cf-grid cf-static" data-static="${key}"${x.dhcp ? ' hidden' : ''}>
            ${text(`${key}.address`, 'IP address', x.address, { mono: true })}
            ${text(`${key}.netmask`, 'Netmask', x.netmask, { mono: true, placeholder: '255.255.255.0' })}
            ${text(`${key}.gateway`, 'Gateway', x.gateway, { mono: true })}
          </div>
        </fieldset>`;
      };
      return `<div class="cf-grid">
          ${text('hostname', 'Hostname', d.hostname, { mono: true })}
          ${text('dns', 'DNS server', d.dns, { mono: true, placeholder: 'from DHCP' })}
        </div>
        <div class="cf-boxes">${iface('eth0', 'Ethernet', d.eth0, false)}${iface('wlan0', 'Wi-Fi', d.wlan0, true)}</div>`;
    },
    read(sec) {
      const ifc = (k, wifi) => {
        const o = { dhcp: chk(sec, `${k}.dhcp`), address: val(sec, `${k}.address`).trim(), netmask: val(sec, `${k}.netmask`).trim(), gateway: val(sec, `${k}.gateway`).trim() };
        if (wifi) {
          o.enabled = chk(sec, `${k}.enabled`);
          o.ssid = val(sec, `${k}.ssid`);
          const psk = val(sec, `${k}.psk`);
          if (psk) o.psk = psk;
        }
        return o;
      };
      return { hostname: val(sec, 'hostname').trim(), dns: val(sec, 'dns').trim(), eth0: ifc('eth0', false), wlan0: ifc('wlan0', true) };
    },
  },

  ikbd: {
    title: 'Keyboard & joysticks',
    hint: () => 'USB keyboard keys that act as Atari joysticks. Key names as in CE_CONF, e.g. A, LCTRL, UP, RSHIFT.',
    render(d) {
      const keys = (j) => `
        <fieldset class="cf-box">
          <legend>Keyboard joystick ${j}</legend>
          ${check(`keybJoy${j}`, `Use keys as joystick ${j}`, d[`keybJoy${j}`])}
          <div class="cf-keys">
            ${['up', 'down', 'left', 'right', 'button'].map((k) => text(`keys.${j}.${k}`, k[0].toUpperCase() + k.slice(1), d.keybJoyKeys[j][k], { mono: true })).join('')}
          </div>
        </fieldset>`;
      return `<div class="cf-checks">
          ${check('joy0First', 'First USB joystick is joystick 0 (mouse port)', d.joy0First)}
          ${check('mouseWheelAsKeys', 'Mouse wheel sends cursor up / down', d.mouseWheelAsKeys)}
        </div>
        <div class="cf-boxes">${keys(0)}${keys(1)}</div>`;
    },
    read(sec) {
      const k = (j) => Object.fromEntries(['up', 'down', 'left', 'right', 'button'].map((x) => [x, val(sec, `keys.${j}.${x}`).trim().toUpperCase()]));
      return { joy0First: chk(sec, 'joy0First'), mouseWheelAsKeys: chk(sec, 'mouseWheelAsKeys'), keybJoy0: chk(sec, 'keybJoy0'), keybJoy1: chk(sec, 'keybJoy1'), keybJoyKeys: [k(0), k(1)] };
    },
  },

  other: {
    title: 'Clock & screen',
    render(d) {
      return `${check('timeSync', 'Set the ST clock from the internet (NTP)', d.timeSync)}
        <div class="cf-grid">
          ${zoneSelect(d.timeZone || '', d.timeZoneRule || '')}
          <div data-tz-offset${d.timeZone ? ' hidden' : ''}>${text('utcOffset', 'UTC offset (hours)', String(d.utcOffset), { type: 'number', step: '0.5', min: '-12', max: '14' })}</div>
          ${text('ntpServer', 'NTP server', d.ntpServer, { mono: true })}
          ${text('screencastFrameskip', 'Screencast frame skip (10–255)', String(d.screencastFrameskip), { type: 'number', min: '10', max: '255' })}
        </div>
        <div class="cf-radios">${radios('screenResolution', 'Config screen resolution on the ST', [['low', 'Low'], ['mid', 'Medium'], ['high', 'High']], d.screenResolution)}</div>`;
    },
    read(sec) {
      return {
        timeSync: chk(sec, 'timeSync'), utcOffset: Number(val(sec, 'utcOffset')) || 0, ntpServer: val(sec, 'ntpServer').trim(),
        timeZone: val(sec, 'timeZone'), timeZoneRule: sec.querySelector('[data-key="timeZone"]')?.selectedOptions[0]?.dataset.rule || '',
        screencastFrameskip: Number(val(sec, 'screencastFrameskip')) || 20, screenResolution: radioVal(sec, 'screenResolution'),
      };
    },
  },

};

// the sections saved with the bar at the bottom (the others save on their own)
const ORDER = ['floppy', 'library', 'ikbd', 'other', 'network', 'shared', 'storageshare', 'weblogin'];

/* ------------------------------------------------------- form helpers */

function text(key, label, value, o = {}) {
  const attrs = Object.entries(o).filter(([k]) => !['mono'].includes(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return `<label class="field"><span>${esc(label)}</span><input class="input${o.mono ? ' mono' : ''}" data-key="${key}" value="${esc(value ?? '')}"${o.type ? '' : ' type="text"'}${attrs} spellcheck="false"></label>`;
}

function check(key, label, on) {
  return `<label class="cf-check"><input type="checkbox" data-key="${key}"${on ? ' checked' : ''}>${esc(label)}</label>`;
}

function radios(key, legend, opts, value) {
  return `<fieldset class="cf-radio"><legend>${esc(legend)}</legend>
    ${opts.map(([v, l]) => `<label class="cf-check"><input type="radio" name="cf-${key}" data-key="${key}" value="${esc(v)}"${value === v ? ' checked' : ''}>${esc(l)}</label>`).join('')}
  </fieldset>`;
}

// The time zone menu: "Fixed UTC offset" (the number field beside it), this
// browser's zone as a shortcut, then all zones by area. Each option carries its
// rule (data-rule), which is saved with the name: the CosmosEx has no time zone
// data of its own. A saved zone this list doesn't have keeps the rule it has.
function zoneSelect(zone, rule) {
  const label = (n) => n.slice(n.indexOf('/') + 1).replace(/_/g, ' ');
  const opt = (n, r, text, sel) => `<option value="${esc(n)}" data-rule="${esc(r)}"${sel ? ' selected' : ''}>${esc(text)}</option>`;
  const rules = new Map(ZONES);
  let here = '';
  try { here = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* none */ }
  const areas = new Map();
  for (const [n, r] of ZONES) {
    const a = n.slice(0, n.indexOf('/'));
    if (!areas.has(a)) areas.set(a, []);
    areas.get(a).push(opt(n, r, label(n), n === zone));
  }
  return `<label class="field"><span>Time zone</span><select class="select" data-key="timeZone">
    <option value="" data-rule=""${zone ? '' : ' selected'}>Fixed UTC offset</option>
    ${zone && !rules.has(zone) ? opt(zone, rule, zone, true) : ''}
    ${rules.has(here) && here !== zone ? opt(here, rules.get(here), `${here.replace(/_/g, ' ')} (this browser's)`, false) : ''}
    ${[...areas].map(([a, o]) => `<optgroup label="${esc(a)}">${o.join('')}</optgroup>`).join('')}
  </select></label>`;
}

// the UTC offset field is there only for "Fixed UTC offset"
document.addEventListener('change', (e) => {
  if (!root || !e.target.matches || !e.target.matches('[data-key="timeZone"]')) return;
  const f = root.querySelector('[data-tz-offset]');
  if (f) f.hidden = !!e.target.value;
});

const val = (sec, key) => sec.querySelector(`[data-key="${key}"]`)?.value ?? '';
const chk = (sec, key) => !!sec.querySelector(`[data-key="${key}"]`)?.checked;
const radioVal = (sec, key) => sec.querySelector(`[data-key="${key}"]:checked`)?.value ?? '';

/* ------------------------------------------------------ library sources */

const SOURCE_TYPES = [['web', 'Web list'], ['share', 'Shared drive folder'], ['usb', 'USB stick folder'], ['local', 'CosmosEx storage folder (/storage)']];

function specParts(src) {
  if (src.type === 'web') return { type: 'web', url: src.url || src.spec };
  if (src.type === 'share') return { type: 'share', path: src.path };
  if (src.type === 'local') return { type: 'local', path: src.path };
  return { type: 'usb', serial: src.serial, path: src.path };
}

// suggestions for IMAGE_STORAGE: the fixed ones and each USB stick with a serial
function storageChoices() {
  const sticks = (st.library && st.library.usb) || [];
  return ['auto', 'shared', 'local:/img_download', ...sticks.filter((u) => u.serial).map((u) => `usb:${u.serial}:/floppy_images`)];
}

function librarySection() {
  const lib = st.library;
  if (!lib) {
    return section('library', 'Floppy image library', '<p class="hint">The library sources couldn\'t be loaded.</p>', '');
  }
  const sticks = lib.usb || [];
  const rows = lib.sources.map((s, i) => libRow({ ...specParts(s), enabled: s.enabled, status: s.status, entries: s.entries, resolved: s.resolved }, i, lib.sources.length, sticks)).join('');
  const body = `
    <ol class="cf-sources" data-sources>${rows}</ol>
    <div class="cf-src-add">
      <button type="button" class="btn btn-secondary" data-src-add${lib.sources.length >= lib.max ? ' disabled' : ''}>Add source</button>
      <button type="button" class="btn btn-secondary" data-src-refresh>Refresh lists</button>
      <span class="hint">At most ${lib.max}. The first source wins when two have the same image.</span>
    </div>
    <div class="cf-usb">
      <h3 class="ov-sub">USB sticks attached now</h3>
      ${sticks.length ? `<ul class="kv-list">${sticks.map((u) => `<li><span class="mono">${esc(u.letter)}:</span> ${esc(u.label || u.device)} <span class="mono hint">${u.serial ? `serial ${esc(u.serial)}` : 'no serial number: can\'t be a library source'}</span></li>`).join('')}</ul>` : '<p class="hint">None. Plug in a stick to use it as a library source by its serial number.</p>'}
    </div>
    <p class="hint">Downloads go to ${lib.storage ? `<span class="mono">${esc(lib.storage)}</span>` : 'a USB drive or the shared drive (none attached now)'}. Images in shared-drive and USB folders are used where they are (a folder's imagelist.csv is used if it has one; otherwise every .st, .msa and .zip in it is listed).</p>`;
  return section('library', 'Floppy image library', body, 'Where the library looks for images, in priority order.');
}

function libRow(s, i, count, sticks) {
  const status = s.enabled === false ? 'disabled' : (s.status || 'new');
  const serials = [...new Set([...(sticks || []).filter((u) => u.serial).map((u) => u.serial), ...(s.serial ? [s.serial] : [])])];
  const where = s.type === 'web'
    ? `<label class="field cf-src-wide"><span>List URL</span><input class="input mono" data-src="url" value="${esc(s.url || '')}" placeholder="http://nas.lan/atari/imagelist.csv" spellcheck="false"></label>`
    : `${s.type === 'usb' ? `<label class="field"><span>Stick serial</span>
          <input class="input mono" data-src="serial" value="${esc(s.serial || '')}" list="cf-serials" placeholder="serial number" spellcheck="false"></label>` : ''}
       <label class="field"><span>Folder</span><input class="input mono" data-src="path" value="${esc(s.path || '/')}" placeholder="/atari/floppies" spellcheck="false"></label>`;
  return `<li class="cf-src" data-src-row data-status="${esc(status)}">
      <span class="mono cf-src-n">${i + 1}</span>
      <div class="cf-src-body">
        <div class="cf-src-top">
          <label class="field"><span>Type</span><select class="select" data-src="type">${SOURCE_TYPES.map(([v, l]) => `<option value="${v}"${s.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          ${where}
        </div>
        <span class="mono hint">${esc(status.replace('_', ' '))}${s.entries ? ` · ${s.entries} images` : ''}${s.type !== 'web' && s.enabled !== false && s.resolved === null ? ' · drive not attached' : ''}</span>
      </div>
      <div class="cf-src-ctl">
        <label class="cf-check"><input type="checkbox" data-src="enabled"${s.enabled !== false ? ' checked' : ''}>Enabled</label>
        <button type="button" class="cf-mini" data-src-move="-1" aria-label="Move source ${i + 1} up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="cf-mini" data-src-move="1" aria-label="Move source ${i + 1} down"${i === count - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" class="cf-mini" data-src-del aria-label="Remove source ${i + 1}">✕</button>
      </div>
      <datalist id="cf-serials">${serials.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    </li>`;
}

function readSources() {
  const rows = [...root.querySelectorAll('[data-src-row]')];
  return rows.map((r) => {
    const g = (k) => r.querySelector(`[data-src="${k}"]`);
    const type = g('type').value;
    const enabled = g('enabled').checked;
    let spec;
    if (type === 'web') spec = (g('url')?.value || '').trim();
    else if (type === 'share') spec = `share:${(g('path')?.value || '/').trim()}`;
    else if (type === 'local') spec = `local:${(g('path')?.value || '/').trim()}`;
    else spec = `usb:${(g('serial')?.value || '').trim()}:${(g('path')?.value || '/').trim()}`;
    return { spec, enabled };
  });
}

// rows as the form has them, for re-rendering after add / move / type change
function formSources() {
  return [...root.querySelectorAll('[data-src-row]')].map((r) => {
    const g = (k) => r.querySelector(`[data-src="${k}"]`);
    return {
      type: g('type').value, url: g('url')?.value, serial: g('serial')?.value, path: g('path')?.value,
      enabled: g('enabled').checked, status: r.dataset.status,
    };
  });
}

function rerenderSources(list) {
  const lib = st.library;
  const ol = root.querySelector('[data-sources]');
  ol.innerHTML = list.map((s, i) => libRow(s, i, list.length, lib.usb)).join('');
  root.querySelector('[data-src-add]').disabled = list.length >= lib.max;
  updateBar();
}

/* --------------------------------------------------------------- render */

function section(id, title, body, hint, status = '') {
  return `<section class="panel cf-sec" id="cf-${id}" data-sec="${id}" aria-labelledby="cf-${id}-h">
      <div class="section-head"><h2 id="cf-${id}-h">${esc(title)}</h2>${status}</div>
      ${hint ? `<p class="hint cf-hint">${esc(hint)}</p>` : ''}
      <div class="cf-problem" data-problem role="alert"></div>
      <div class="cf-body">${body}</div>
    </section>`;
}

function renderAll() {
  if (!root || !st.saved) return;
  const one = (id) => {
    if (id === 'library') return librarySection();
    if (id === 'software') return softwareSection();
    if (id === 'backup') return backupSection();
    if (id === 'experimental') return experimentalSection();
    const def = SECTIONS[id];
    const d = st.saved[id];
    if (!d) return '';
    return section(id, def.title, def.render(d), def.hint ? def.hint(d) : '', def.status ? def.status(d) : '');
  };
  const html = GROUPS.map((g) => {
    const secs = g.items.map((n) => one(n.id)).join('');
    return secs ? `<p class="eyebrow cf-group">${esc(g.label)}</p>${secs}` : '';
  }).join('');
  q('main').innerHTML = html;
  for (const id of Object.keys(st.errors)) showProblem(id);
  for (const id of Object.keys(st.warnings)) showProblem(id);
  watchNav();
}

function softwareSection() {
  const s = latest();
  const v = (s && s.versions) || {};
  const row = (k, x, detail) => `<div class="stat"><div class="stat-label mono">${esc(k)}</div><div class="stat-state mono">${esc(x || '—')}</div>${detail ? `<div class="stat-detail">${detail}</div>` : ''}</div>`;
  return `<section class="panel cf-sec" id="cf-software" aria-labelledby="cf-software-h">
      <div class="section-head"><h2 id="cf-software-h">Software &amp; update</h2></div>
      <div class="stat-grid">${row('System', st.system && st.system.available ? st.system.version : '')}${row('ce_main_app', v.app)}${row('Hans firmware', v.hans)}${row('Franz firmware', v.franz)}${v.xilinx || !s ? row('Xilinx', v.xilinx) : row('Xilinx', 'Unknown', 'Not flashed by this system. <span class="mono">doflash.txt</span> on the boot partition flashes it.')}</div>
      <div data-sysupd>${systemUpdateHtml()}</div>
      <div data-flashbox>${flashHtml()}</div>
    </section>`;
}

/* ---------------------------------------------------------- experimental */

// saved at once (no Save bar): POST /api/v1/files/options
function experimentalSection() {
  const o = st.files;
  if (!o) return '';
  return `<section class="panel cf-sec" id="cf-experimental" aria-labelledby="cf-experimental-h">
      <div class="section-head"><h2 id="cf-experimental-h">Experimental</h2></div>
      ${devModeBox()}
      <label class="cf-check"><input type="checkbox" data-exp="gemdosWrite"${o.gemdosWrite ? ' checked' : ''}>Files page: write to big Atari partitions and byte-swapped images</label>
      <p class="hint">Hard disk images: GEMDOS partitions with logical sectors over 4 KB (big AHDI/HDDRIVER partitions) and byte-swapped images (from some emulators) are read through a translator; with this on, the Files page can also change them (upload, copy into, rename, delete). New and not tested on many disks: <b>keep a copy of the image</b>. Off: they can be browsed and copied from. Changed at once; images open on the Files page are closed so it takes effect.</p>
      <p class="hint" data-exp-note role="status"></p>
    </section>`;
}

// Developer mode: the app's own web server reachable without nginx
// (GET/POST /api/v1/system/devmode); used from the next restart
function devModeText(d) {
  const at = `http://${location.hostname}:${d.port}/`;
  const now = d.active ? `Now: the app answers at <a href="${esc(at)}">${esc(at)}</a> too.` : 'Now: the app is reachable through port 80 only.';
  const want = d.setting || d.file;
  const next = want === d.active ? '' : (want ? ' On from the next restart of the CosmosEx.' : ' Off from the next restart of the CosmosEx.');
  return `${now}${next}${d.file ? ' <span class="mono">devmode.txt</span> on the boot partition keeps it on whatever is set here.' : ''}`;
}
function devModeBox() {
  const d = st.devmode;
  if (!d || !d.available) return '';
  return `<label class="cf-check"><input type="checkbox" data-dev="on"${d.setting ? ' checked' : ''}>Developer mode: the app's own web server on port ${d.port}</label>
      <p class="hint">The web interface comes through nginx on port 80. With this on, the app also answers directly on port ${d.port}, so that a restart or an update can still be started from a browser if nginx doesn't work. The login applies there too.</p>
      <p class="hint" data-dev-note role="status">${devModeText(d)}</p>`;
}
async function saveDevMode(t) {
  const note = root.querySelector('[data-dev-note]');
  try {
    const r = await fetch('/api/v1/system/devmode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: t.checked }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    st.devmode = d;
    if (note) { note.innerHTML = devModeText(d); note.classList.remove('cf-warn'); }
  } catch (e) {
    t.checked = !t.checked;
    if (note) { note.textContent = `Not saved: ${e.message}`; note.classList.add('cf-warn'); }
  }
}

async function saveExperimental(t) {
  const note = root.querySelector('[data-exp-note]');
  try {
    const r = await fetch('/api/v1/files/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [t.dataset.exp]: t.checked }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    st.files = d;
    if (note) { note.textContent = t.checked ? 'On: big partitions and swapped images can be changed on the Files page.' : 'Off: big partitions and swapped images are read-only.'; note.classList.remove('cf-warn'); }
  } catch (e) {
    t.checked = !t.checked;
    if (note) { note.textContent = `Not saved: ${e.message}`; note.classList.add('cf-warn'); }
  }
}

/* ------------------------------------------------------ backup & restore */

let bkTimer = null;
let bkXhr = null;
let bkUpload = null;            // { name, sent, total }
let bkRestarting = false;

const kbText = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`);

function backupSection() {
  return `<section class="panel cf-sec" id="cf-backup" aria-labelledby="cf-backup-h">
      <div class="section-head"><h2 id="cf-backup-h">Backup &amp; restore</h2></div>
      <div data-bk>${backupHtml()}</div>
    </section>`;
}

function backupHtml() {
  const d = st.backup;
  if (!d) return '<p class="hint">Backups need this CosmosEx image\'s backup tool.</p>';
  let html = '<p class="hint">A backup holds what you set up and what the ST saved. To move to a new or rewritten card: write the image, start the CosmosEx, open this page and restore the backup.</p>';

  if (bkUpload) {
    const pct = bkUpload.total ? Math.floor(bkUpload.sent * 100 / bkUpload.total) : 0;
    return html + `<div class="cf-sys-run" role="status"><p class="mono">UPLOADING ${esc(bkUpload.name)} · ${fmtMB(bkUpload.sent)} of ${fmtMB(bkUpload.total)}</p>
      <progress max="100" value="${pct}"></progress></div>`;
  }
  if (bkRestarting) {
    return html + `<div class="cf-sys-run" role="status"><p class="mono">RESTORING · THE COSMOSEX RESTARTS</p>
      <p class="hint">The backup is checked, put in place, and the CosmosEx restarts (about a minute). You may have to log in again, with the restored password.</p></div>`;
  }
  const r = d.restore;
  if (r && (r.state === 'done' || r.state === 'failed')) {
    html += `<p class="hint${r.state === 'failed' ? ' cf-warn' : ''}" role="status">${r.state === 'failed' ? 'Last restore failed: ' : ''}${esc(r.message || '')}${r.time ? ` <span class="mono">(${esc(r.time)})</span>` : ''}</p>`;
  }

  const store = d.storage;
  html += `<div class="cf-sys-grid">
    <fieldset class="cf-box">
      <legend>Make a backup</legend>
      <ul class="cf-bk-list">
        <li><b>Settings</b>: every CosmosEx setting, network and Wi-Fi network, hostname, sharing, the SSH keys you log in with (${d.sshKeys || 0}) <span class="mono hint">${kbText(d.settingsKB || 0)}</span></li>
        ${store ? `<li><b>Save disks</b>: ${d.saveDisks || 0} floppies the ST wrote to <span class="mono hint">${kbText(d.saveDisksKB || 0)}</span></li>
        <li><b>Notes</b> about your hard disk images</li>` : '<li class="hint">The storage (/storage) isn\'t mounted: save disks and files aren\'t available.</li>'}
      </ul>
      ${store ? `<label class="cf-check"><input type="checkbox" data-bk-opt="translated"${d.translatedKB ? ' checked' : ' disabled'}>Files of the translated drives on the CosmosEx${d.translatedDrives ? ` (${esc(d.translatedDrives.split('').join(', '))}:)` : ''} <span class="mono hint">${kbText(d.translatedKB || 0)}</span></label>
      <label class="cf-check"><input type="checkbox" data-bk-opt="downloads"${d.downloadsKB ? '' : ' disabled'}>Downloaded floppy images (they can be downloaded again) <span class="mono hint">${kbText(d.downloadsKB || 0)}</span></label>` : ''}
      <label class="cf-check"><input type="checkbox" data-bk-opt="secrets">Include passwords and keys (Wi-Fi, shared drive, SMB, web login, the CosmosEx's SSH identity): the file is then encrypted</label>
      <div class="cf-grid" data-bk-pw hidden>
        <label class="field"><span>Backup password</span><input class="input" type="password" data-bk-pw1 autocomplete="new-password" minlength="8"></label>
        <label class="field"><span>Backup password again</span><input class="input" type="password" data-bk-pw2 autocomplete="new-password" minlength="8"></label>
        <p class="hint cf-src-wide">At least 8 characters. Without it the backup can't be restored: keep it somewhere safe. Without passwords and keys, a restore keeps the ones the CosmosEx has and lists what to enter again.</p>
      </div>
      <div class="cf-bk-warn">
        <p><b>Hard disk images are not in the backup.</b> ${d.hddImages ? `You have ${d.hddImages} in <span class="mono">/storage/hdd_images</span> (${d.hddImagesMB} MB): download them on the <a href="#/harddisk">Hard disk</a> page, or copy them over the network, and keep them with the backup.` : 'Images you put in <span class="mono">/storage/hdd_images</span> later have to be saved by hand: download them on the <a href="#/harddisk">Hard disk</a> page, or copy them over the network.'}</p>
        <label class="cf-check"><input type="checkbox" data-bk-ok>Yes, I understand</label>
      </div>
      <div class="cf-sys-btns"><button type="button" class="btn btn-primary" data-bk="download" disabled>Download backup</button></div>
    </fieldset>
    <fieldset class="cf-box">
      <legend>Restore</legend>
      <p class="hint">A backup file of a CosmosEx (<span class="mono">cosmosex-backup-….tar.gz</span>, or <span class="mono">….tar.gz.enc</span> with passwords and keys). It replaces the settings and puts the files back (files of the same name are replaced); the settings before it are kept in <span class="mono">/data/ce/settings.before-restore</span>. Then the CosmosEx restarts.</p>
      <input class="input" type="file" accept=".gz,.tgz,.enc,application/gzip" data-bk-file>
      <label class="field"><span>Backup password (only for an encrypted backup)</span><input class="input" type="password" data-bk-rpw autocomplete="off"></label>
      <p class="hint cf-warn" data-bk-err hidden></p>
      <div class="cf-sys-btns"><button type="button" class="btn btn-secondary" data-bk="restore">Restore</button></div>
    </fieldset>
  </div>`;
  return html;
}

function renderBackup() {
  const box = root && root.querySelector('[data-bk]');
  if (box) box.innerHTML = backupHtml();
}

function bkError(msg) {
  const p = root && root.querySelector('[data-bk-err]');
  if (p) { p.textContent = msg; p.hidden = !msg; }
}

// the download button needs "Yes, I understand"; passwords and keys need a backup password
document.addEventListener('change', (e) => {
  if (!root || !e.target.matches) return;
  if (e.target.matches('[data-bk-ok]')) {
    const b = root.querySelector('[data-bk="download"]');
    if (b) b.disabled = !e.target.checked;
  }
  if (e.target.matches('[data-bk-opt="secrets"]')) {
    const f = root.querySelector('[data-bk-pw]');
    if (f) f.hidden = !e.target.checked;
  }
});

// the Next boot radios in "Systems on this card"
document.addEventListener('change', (e) => {
  if (!root || !e.target.matches || !e.target.matches('[data-sys-pick]')) return;
  sysPick(e.target);
});

async function sysPick(r) {
  const d = st.system;
  const x = r.value;
  if (x === (d.nextSlot || d.defaultSlot)) return;
  sysError('');
  root.querySelectorAll('[data-sys-pick]').forEach((i) => { i.disabled = true; });
  try {
    st.system = await api('/api/v1/system/update/boot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: x }) });
  } catch (e) {
    renderSystem();
    sysError(e.message);
    return;
  }
  renderSystem();
  pollSystem();
}

function backupAction(b) {
  if (b.dataset.bk === 'download') {
    const opt = (k) => !!root.querySelector(`[data-bk-opt="${k}"]`)?.checked;
    if (!opt('secrets')) {
      location.href = `/api/v1/system/backup/download?translated=${opt('translated') ? 1 : 0}&downloads=${opt('downloads') ? 1 : 0}`;
      return;
    }
    const pw1 = root.querySelector('[data-bk-pw1]').value, pw2 = root.querySelector('[data-bk-pw2]').value;
    if (pw1.length < 8) { bkError('The backup password: at least 8 characters.'); return; }
    if (pw1 !== pw2) { bkError('The two backup passwords differ.'); return; }
    bkError('');
    b.disabled = true;
    b.textContent = 'Making the backup…';
    // encrypted: a POST (the password doesn't go into a URL), saved from the answer
    fetch('/api/v1/system/backup/download', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ translated: opt('translated'), downloads: opt('downloads'), secrets: true, password: pw1 }) })
      .then(async (r) => {
        if (!r.ok) { let m = `HTTP ${r.status}`; try { m = (await r.json()).error || m; } catch (e) { /* not JSON */ } throw new Error(m); }
        const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'cosmosex-backup.tar.gz.enc';
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      })
      .catch((e) => bkError(e.message))
      .finally(() => { b.disabled = false; b.textContent = 'Download backup'; });
    return;
  }
  const input = root.querySelector('[data-bk-file]');
  const f = input && input.files && input.files[0];
  if (!f) { bkError('Choose a backup file first.'); return; }
  if (!window.confirm(`Restore ${f.name}? It replaces this CosmosEx's settings and restarts it.`)) return;
  bkError('');
  bkUpload = { name: f.name, sent: 0, total: f.size };
  renderBackup();
  const x = new XMLHttpRequest();
  bkXhr = x;
  x.open('POST', '/api/v1/system/backup/restore');
  x.setRequestHeader('Content-Type', 'application/octet-stream');
  const rpw = root.querySelector('[data-bk-rpw]')?.value || '';
  if (rpw) x.setRequestHeader('X-Backup-Password', encodeURIComponent(rpw));     // (headers take ASCII only)
  let shown = 0;
  x.upload.onprogress = (e) => {
    bkUpload.sent = e.loaded;
    if (Date.now() - shown > 400) { shown = Date.now(); renderBackup(); }
  };
  x.onload = () => {
    bkUpload = null;
    bkXhr = null;
    let body = null;
    try { body = JSON.parse(x.responseText); } catch (e) { /* not JSON */ }
    if (x.status === 401) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; return; }
    if (x.status !== 200) { renderBackup(); bkError((body && body.error) || `Upload failed (HTTP ${x.status}).`); return; }
    bkRestarting = true;
    renderBackup();
    pollBackup(0);
  };
  x.onerror = () => {
    const whole = bkUpload && bkUpload.total > 0 && bkUpload.sent >= bkUpload.total;
    bkUpload = null;
    bkXhr = null;
    if (whole) {                    // all sent, then no answer: the restore took the web server down (restarting)
      bkRestarting = true;
      renderBackup();
      pollBackup(0);
      return;
    }
    renderBackup();
    bkError('The upload was interrupted.');
  };
  x.send(f);
}

// after a restore: wait for the restart (no answer), then for the CosmosEx to be back
function pollBackup(lost) {
  clearTimeout(bkTimer);
  bkTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/v1/system/backup', { cache: 'no-store' });
      if (r.status === 401) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; return; }
      const d = await r.json();
      if (!root) return;
      if (lost > 0 || (d.restore && d.restore.state === 'failed')) {     // back after the restart (or it failed before)
        bkRestarting = false;
        st.backup = d;
        renderBackup();
        return;
      }
      pollBackup(0);
    } catch (e) {
      if (root) pollBackup(lost + 1);
    }
  }, 3000);
}

/* ------------------------------------------------------- system update */

let sysTimer = null;
let sysXhr = null;                 // the upload running
let sysUpload = null;              // its progress: { name, sent, total }
let sysLost = 0;                   // polls without an answer (restarting)
let flashRestarting = '';          // "Hans and Franz": restarting to flash them

const SYS_ACTIVE = ['checking', 'downloading', 'verifying', 'writing', 'bootfiles', 'restarting'];
const fmtMB = (b) => `${Math.round(b / 1048576)} MB`;

// 2026.11.15.2 vs 2026.11.16: numbers compared as numbers; dev builds are older than any release
function cmpVersion(a, b) {
  const pa = /^[\d.]+$/.test(a || '') ? a.split('.').map(Number) : null;
  const pb = /^[\d.]+$/.test(b || '') ? b.split('.').map(Number) : null;
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function systemUpdateHtml() {
  const d = st.system;
  if (!d || !d.available) {
    return '<p class="hint">System updates need this CosmosEx image\'s update tool; update by writing a new image to the card.</p>';
  }
  const active = d.busy || SYS_ACTIVE.includes(d.state) || sysUpload;
  const L = d.latest;
  const newer = L && cmpVersion(L.version, d.version) > 0;
  let html = `<p class="hint">Running: <b class="mono">${esc(d.version)}</b> (${esc(d.variant)}).</p>`;

  // what is happening now / happened last
  if (sysUpload) {
    const pct = sysUpload.total ? Math.floor(sysUpload.sent * 100 / sysUpload.total) : 0;
    html += `<div class="cf-sys-run" role="status"><p class="mono">UPLOADING ${esc(sysUpload.name)} · ${fmtMB(sysUpload.sent)} of ${fmtMB(sysUpload.total)}</p>
      <progress max="100" value="${pct}"></progress><p class="hint">Keep this page open until the upload is done.</p></div>`;
  } else if (sysLost && (d.state === 'restarting' || sysLost > 1)) {
    html += flashRestarting ? `<div class="cf-sys-run" role="status"><p class="mono">RESTARTING · FLASHING ${esc(flashRestarting.toUpperCase())}</p>
      <p class="hint">The chips are flashed before the CosmosEx app starts: a minute or two. Don't switch the CosmosEx off. You may have to log in again.</p></div>` : `<div class="cf-sys-run" role="status"><p class="mono">RESTARTING · WAITING FOR THE COSMOSEX</p>
      <p class="hint">${d.staged || d.trying || d.state === 'restarting' && /try/.test(d.message || '') ? 'It starts the new system once to try it (about a minute), and keeps it if the CosmosEx app works.' : 'About a minute.'} You may have to log in again.</p></div>`;
  } else if (active) {
    html += `<div class="cf-sys-run" role="status"><p class="mono">${esc((d.state || '').toUpperCase())}${d.message ? ` · ${esc(d.message)}` : ''}</p>
      ${d.state === 'checking' || d.state === 'restarting' ? '' : `<progress max="100" value="${Number(d.progress) || 0}"></progress>`}
      <p class="hint">Don't switch the CosmosEx off now. Your current system stays unchanged until the new one has started and works.</p></div>`;
  } else if (d.state === 'staged' && d.staged) {
    html += `<div class="cf-sys-run cf-sys-trial" role="status"><p>${esc(d.message || '')}</p>
      <div class="cf-sys-btns"><button type="button" class="btn btn-primary" data-sys="restart">Restart into ${esc(d.staged)} now</button>
      <button type="button" class="btn btn-secondary" data-sys="boot" data-slot="${esc(d.slot)}">Don't start it</button></div></div>`;
  } else if (d.state === 'trial') {
    html += `<div class="cf-sys-run cf-sys-trial" role="status"><p>${esc(d.message || '')}</p>
      <div class="cf-sys-btns"><button type="button" class="btn btn-primary" data-sys="keep">Keep ${esc(d.trying || 'it')}</button>
      <button type="button" class="btn btn-secondary" data-sys="back">Go back</button></div></div>`;
  } else if (d.state === 'done' || d.state === 'failed') {
    html += `<p class="hint${d.state === 'failed' ? ' cf-warn' : ''}" role="status">${d.state === 'failed' ? 'Last update: ' : ''}${esc(d.message || '')}${d.time ? ` <span class="mono">(${esc(d.time)})</span>` : ''}</p>`;
  }

  const off = active || d.state === 'trial' ? ' disabled' : '';
  // both systems on the card, and which one the next start uses
  const next = d.nextSlot || d.defaultSlot;
  const rows = ['a', 'b'].map((x) => {
    const v = x === 'a' ? d.slotA : d.slotB;
    const dis = !v || off ? ' disabled' : '';
    // Active only shows the running system (switch with Next boot, then Restart now)
    const radio = (kind, on, label) => `<label class="cf-sys-radio"><input type="radio" name="cf-sys-${kind}" value="${x}"${kind === 'next' ? ' data-sys-pick="next"' : ''}${on ? ' checked' : ''}${on ? '' : kind === 'next' ? dis : ' disabled'} aria-label="${label}: system ${x.toUpperCase()}"><span class="cf-sys-rl">${label}</span></label>`;
    const note = v && x === next && d.staged && x !== d.slot ? 'once, to try it' : '';
    return `<tr><td>System ${x.toUpperCase()} <span class="hint">(partition ${x === 'a' ? 2 : 3})</span></td>
      <td class="mono">${v ? esc(v) : '<span class="hint">empty</span>'}</td>
      <td>${radio('active', x === d.slot, 'Active')}</td><td>${radio('next', v && x === next, 'Next boot')}</td><td class="hint">${note}</td></tr>`;
  }).join('');
  html += `<fieldset class="cf-box"><legend>Systems on this card</legend>
    <table class="cf-sys-slots"><thead><tr><th></th><th></th><th>Active</th><th>Next boot</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Active: the system running now. Next boot: the system the next start uses; to switch, choose it here and restart${d.state === 'staged' ? '' : '. The update buttons need the active one as next boot'}.</p>
    <div class="cf-sys-btns"><button type="button" class="btn btn-secondary" data-sys="restart"${off}>Restart now</button></div>
  </fieldset>`;
  const two = (attrs, label) => `<button type="button" class="btn btn-primary" ${attrs}${off}>${label} and restart</button>
        <button type="button" class="btn btn-secondary" ${attrs} data-restart="no"${off}>${label} only</button>`;
  html += `<div class="cf-sys-grid">
    <fieldset class="cf-box">
      <legend>From the CosmosEx site</legend>
      <p class="hint">${L ? `Newest: <b class="mono">${esc(L.version)}</b> (${esc(L.date || '')}${L.size ? `, ${fmtMB(L.size)} download` : ''})${newer ? '' : cmpVersion(L.version, d.version) === 0 ? ' · this is the installed one' : ' · older than the installed one'}.` : 'Not checked yet.'}
</p>
      <p class="hint cf-warn" data-sys-err hidden></p>
      <div class="cf-sys-btns">
        <button type="button" class="btn btn-secondary" data-sys="check"${off}>Check now</button>
        ${L ? two(`data-sys="online" data-ver="${esc(L.version)}"`, `Install ${esc(L.version)}`) : ''}
      </div>
    </fieldset>
    <fieldset class="cf-box">
      <legend>From a file</legend>
      <p class="hint">An SD card image of this CosmosEx's kind (<span class="mono">${esc(d.variant)}</span>), <span class="mono">.img.xz</span> as published, or <span class="mono">.img</span>.</p>
      <input class="input" type="file" accept=".xz,.img" data-sys-file${off}>
      <div class="cf-sys-btns">${two('data-sys="upload"', 'Install')}</div>
      ${(d.usbImages || []).length ? `<p class="hint">On a USB stick:</p><ul class="cf-bk-list">${d.usbImages.map((u) => `<li><span class="mono">${esc(u.path.split('/').pop())}</span> <span class="hint">${esc(u.path.split('/')[2] || '')} · ${u.sizeMB} MB</span>
        <button type="button" class="btn-link" data-sys="usb" data-path="${esc(u.path)}"${off}>Install and restart</button>
        <button type="button" class="btn-link" data-sys="usb" data-path="${esc(u.path)}" data-restart="no"${off}>Install only</button></li>`).join('')}</ul>` : '<p class="hint">Or put <span class="mono">cosmosex-….img.xz</span> in the top folder of a USB stick: it shows here.</p>'}
    </fieldset>
  </div>
  <label class="cf-sys-list"><span class="hint">The CosmosEx site's list of published images (<span class="mono">latest.json</span>): where Check now looks</span>
    <span class="cf-sys-list-row"><input class="input mono" type="url" data-sys-list value="${esc(d.list || '')}" placeholder="${esc(d.listDefault || 'https://…/latest.json')}" maxlength="300" spellcheck="false" autocomplete="off" autocapitalize="off"${off}>
    <button type="button" class="btn btn-secondary" data-sys="list"${off}>Save</button>
    ${d.listDefault && d.list !== d.listDefault ? `<button type="button" class="btn-link" data-sys="list" data-default="yes"${off}>Use the default</button>` : ''}</span></label>
  <p class="hint">How it works: the new system is written next to the current one (replacing the other system on the card), then the CosmosEx starts it once to try it and keeps it only if it works: right away (… and restart), or at the next start (… only: restart here, or switch off and on). If it doesn't start, switch the CosmosEx off and on: the current system starts, unchanged. Settings, your files in /storage and the shared drives are kept. The update takes a few minutes; the Atari can stay on.</p>`;
  return html;
}

// Hans and Franz: flashed at the next start, before the app starts (ce-flash)
function flashHtml() {
  const f = st.flash;
  if (!f || !f.available) return '';
  const d = st.system || {};
  const v = (latest() || {}).versions || {};
  const busy = d.busy || SYS_ACTIVE.includes(d.state) || sysUpload || flashRestarting;
  const last = f.result ? `<p class="hint${f.result === 'failed' ? ' cf-warn' : ''}" role="status">Last flash: ${esc(f.message || f.result)} <span class="mono">(${esc(f.last || '')})</span></p>` : '';
  return `<fieldset class="cf-box cf-flash"><legend>Chip firmware</legend>
    <p class="hint">On the chips: Hans <span class="mono">${esc(v.hans || 'unknown')}</span>, Franz <span class="mono">${esc(v.franz || 'unknown')}</span>.
      In this system: Hans <span class="mono">${esc(f.hansVersion || '?')}</span>, Franz <span class="mono">${esc(f.franzVersion || '?')}</span>.</p>
    ${last}
    <p class="hint cf-warn" data-flash-err hidden></p>
    <div class="cf-sys-btns"><button type="button" class="btn btn-secondary" data-flash="hans,franz"${busy ? ' disabled' : ''}>Flash Hans and Franz</button></div>
    <p class="hint">Writes this system's firmware to Hans and Franz, the two chips on the CosmosEx board: for chips that lost or have other firmware. The CosmosEx restarts and flashes them before its app starts, a minute or two; meanwhile the Atari has no CosmosEx drives.</p>
  </fieldset>`;
}

function renderFlash() {
  const box = root && root.querySelector('[data-flashbox]');
  if (box) box.innerHTML = flashHtml();
}

async function flashAction(b) {
  const f = st.flash || {};
  const chips = b.dataset.flash.split(',');
  const names = chips.map((c) => c[0].toUpperCase() + c.slice(1)).join(' and ');
  if (!window.confirm(`Flash ${names} with this system's firmware (Hans ${f.hansVersion || '?'}, Franz ${f.franzVersion || '?'})?\n\nThe CosmosEx restarts now and flashes them before its app starts (a minute or two). Don't switch it off meanwhile.`)) return;
  const err = root.querySelector('[data-flash-err]');
  if (err) err.hidden = true;
  b.disabled = true;
  try {
    st.flash = await api('/api/v1/system/flash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chips }) });
  } catch (e) {
    b.disabled = false;
    if (err) { err.textContent = e.message; err.hidden = false; }
    return;
  }
  flashRestarting = names;
  if (st.system) st.system.state = 'restarting';
  sysLost = 1;
  renderSystem();
  renderFlash();
  pollSystem();
  root.querySelector('[data-sysupd]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderSystem() {
  const box = root && root.querySelector('[data-sysupd]');
  if (box) box.innerHTML = systemUpdateHtml();
  renderFlash();
  const sv = root && root.querySelector('#cf-software .stat-state');
  if (sv && st.system && st.system.available) sv.textContent = st.system.version;
}

function sysError(msg) {
  const p = root && root.querySelector('[data-sys-err]');
  if (p) { p.textContent = msg; p.hidden = !msg; }
}

// while something runs: ask every 2 s; through a restart, until it answers again
function pollSystem() {
  clearTimeout(sysTimer);
  const d = st.system;
  const waiting = sysLost || (d && (d.busy || SYS_ACTIVE.includes(d.state) || (d.state === 'trial' && /waiting/i.test(d.message || ''))));
  if (!root || !waiting) return;
  sysTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/v1/system/update', { cache: 'no-store' });
      if (r.status === 401) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; return; }
      st.system = await r.json();
      sysLost = 0;
      if (flashRestarting) {
        flashRestarting = '';
        st.flash = await api('/api/v1/system/flash').catch(() => st.flash);
        renderFlash();
      }
    } catch (e) {
      sysLost++;
    }
    if (!root) return;
    renderSystem();
    pollSystem();
  }, sysLost ? 3000 : 2000);
}

async function sysAction(b) {
  const what = b.dataset.sys;
  const d = st.system;
  const restart = b.dataset.restart !== 'no';
  if (what === 'upload') { uploadSystem(restart); return; }
  let listUrl = '';
  if (what === 'list' && b.dataset.default !== 'yes') {
    listUrl = (root.querySelector('[data-sys-list]')?.value || '').trim();
    if (listUrl && !/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._~%+/-]*)?$/.test(listUrl)) {
      sysError('That isn\'t an address this can use: http:// or https://, and only letters, digits and . - _ ~ % + / in it.');
      return;
    }
  }
  const then = restart ? 'The CosmosEx restarts during the update (a few minutes).' : 'It\'s tried at the next start; this system keeps running until then.';
  const ask = {
    online: `Install ${b.dataset.ver}? ${then}`,
    back: 'Go back to the previous system? The CosmosEx restarts.',
    previous: `Start ${d.previous && d.previous !== 'unknown' ? d.previous : 'the previous system'} again? The CosmosEx restarts.`,
    usb: `Install ${(b.dataset.path || '').split('/').pop()} from the USB stick? ${then}`,
    restart: d.staged && d.state === 'staged' ? `Restart into ${d.staged} (once, to try it)?` : 'Restart the CosmosEx?',
  }[what];
  if (ask && !window.confirm(ask)) return;
  b.disabled = true;
  sysError('');
  try {
    st.system = await api(`/api/v1/system/update/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(what === 'usb' ? { path: b.dataset.path, restart } : what === 'online' ? { restart } : what === 'boot' ? { slot: b.dataset.slot } : what === 'list' ? { url: listUrl } : {}) });
    if (what === 'back' || what === 'previous' || what === 'restart') { st.system.state = 'restarting'; sysLost = 1; }
    renderSystem();
    pollSystem();
  } catch (e) {
    b.disabled = false;
    sysError(e.message);
  }
}

function uploadSystem(restart) {
  const input = root.querySelector('[data-sys-file]');
  const f = input && input.files && input.files[0];
  if (!f) { sysError('Choose an image file first.'); return; }
  if (!/\.(img|img\.xz|xz)$/i.test(f.name)) { sysError('That isn\'t an .img or .img.xz file.'); return; }
  if (!window.confirm(`Install ${f.name} (${fmtMB(f.size)})? ${restart ? 'The CosmosEx restarts during the update.' : 'It\'s tried at the next start; this system keeps running until then.'}`)) return;
  sysError('');
  sysUpload = { name: f.name, sent: 0, total: f.size };
  renderSystem();
  const x = new XMLHttpRequest();
  sysXhr = x;
  x.open('POST', '/api/v1/system/update/upload');
  x.setRequestHeader('Content-Type', 'application/octet-stream');
  x.setRequestHeader('X-File-Name', f.name.replace(/[^\x20-\x7e]/g, '_'));
  if (!restart) x.setRequestHeader('X-Restart', 'no');
  let shown = 0;
  x.upload.onprogress = (e) => {
    sysUpload.sent = e.loaded;
    if (Date.now() - shown > 400) { shown = Date.now(); renderSystem(); }
  };
  x.onload = () => {
    sysUpload = null;
    sysXhr = null;
    let body = null;
    try { body = JSON.parse(x.responseText); } catch (e) { /* not JSON */ }
    if (x.status === 401) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; return; }
    if (x.status !== 200) { renderSystem(); sysError((body && body.error) || `Upload failed (HTTP ${x.status}).`); return; }
    st.system = body;
    renderSystem();
    pollSystem();
  };
  x.onerror = () => { sysUpload = null; sysXhr = null; renderSystem(); sysError('The upload was interrupted.'); };
  x.send(f);
}

function watchNav() {
  if (observer) observer.disconnect();
  const links = [...root.querySelectorAll('[data-goto]')];
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.sec || e.target.id.replace(/^cf-/, '');
      for (const a of links) a.toggleAttribute('aria-current', a.dataset.goto === id);
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  for (const s of root.querySelectorAll('.cf-sec')) observer.observe(s);
}

/* ---------------------------------------------------------------- dirty */

function dirtySections() {
  if (!st.saved) return [];
  const out = [];
  for (const id of ORDER) {
    const sec = root.querySelector(`[data-sec="${id}"]`);
    if (!sec) continue;
    if (id === 'library') {
      if (!st.library) continue;
      const was = st.library.sources.map((s) => ({ spec: s.spec, enabled: s.enabled }));
      if (JSON.stringify(readSources()) !== JSON.stringify(was)) out.push(id);
      continue;
    }
    const now = SECTIONS[id].read(sec);
    const was = SECTIONS[id].read(sectionFromSaved(id));
    if (JSON.stringify(now) !== JSON.stringify(was)) out.push(id);
  }
  return out;
}

// a detached copy of a section rendered from the saved data, to compare with
function sectionFromSaved(id) {
  const t = document.createElement('div');
  t.innerHTML = SECTIONS[id].render(st.saved[id]);
  return t;
}

function updateBar() {
  if (!root) return;
  const dirty = dirtySections();
  const bar = q('bar');
  bar.classList.toggle('dirty', dirty.length > 0);
  q('save').disabled = !dirty.length || st.saving;
  q('cancel').disabled = !dirty.length || st.saving;
  const problems = Object.keys(st.errors);
  let text;
  if (st.saving) text = 'SAVING…';
  else if (dirty.length) text = `UNSAVED CHANGES · ${dirty.map((d) => (NAV.find((n) => n.id === d) || { label: SECTIONS[d]?.title || d }).label).join(', ')}`;
  else if (problems.length) text = 'NOT SAVED: SEE THE MARKED SECTION';
  else text = st.savedNote || 'ALL CHANGES SAVED';
  q('bartext').textContent = text;
}

/* ---------------------------------------------------------------- Wi-Fi: networks in range */
// The name field is a text field with a list under it: the networks the
// CosmosEx hears (GET /api/v1/system/wifiscan), narrowed while typing. Any
// name can still be typed (a network that hides its name).

const wifi = { nets: null, scanning: false, typed: false, cur: -1, error: '' };
const wq = (s) => root && root.querySelector(`[data-wifi-${s}]`);
const SECURITY = { open: 'open', wep: 'WEP', wpa: 'WPA', wpa3: 'WPA3 only', eap: 'enterprise' };

// one row per name: the strongest access point, and the bands it's on
function wifiGroup(list) {
  const by = new Map();
  for (const n of list || []) {
    const g = by.get(n.ssid) || { ssid: n.ssid, signal: -200, security: n.security, bands: new Set() };
    if (n.signal > g.signal) { g.signal = n.signal; g.security = n.security; }
    g.bands.add(n.freq >= 5925 ? '6' : n.freq >= 4900 ? '5' : '2.4');
    by.set(n.ssid, g);
  }
  return [...by.values()].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

function wifiShown() {
  const input = wq('in');
  const all = wifi.nets || [];
  const t = wifi.typed && input ? input.value.trim().toLowerCase() : '';
  return t ? all.filter((n) => n.ssid.toLowerCase().includes(t)) : all;
}

const wifiBars = (dbm) => (dbm >= -55 ? 4 : dbm >= -67 ? 3 : dbm >= -78 ? 2 : 1);

function wifiRender(open) {
  const input = wq('in'), list = wq('list'), note = wq('note'), btn = wq('scan');
  if (!input) return;
  const rows = wifiShown();
  if (wifi.cur >= rows.length) wifi.cur = rows.length - 1;
  const show = open && rows.length > 0 && !wifi.scanning;
  list.innerHTML = rows.map((n, i) => {
    const bars = wifiBars(n.signal);
    return `<li role="option" id="cf-wifi-o${i}" data-wifi-pick="${i}" aria-selected="${i === wifi.cur}"${i === wifi.cur ? ' class="cur"' : ''}>
        <span class="cf-wifi-name">${esc(n.ssid)}</span>
        <span class="cf-wifi-meta mono">${esc(SECURITY[n.security] || n.security)} · ${[...n.bands].sort().join(' + ')} GHz</span>
        <span class="cf-wifi-bars" title="${n.signal} dBm" aria-label="signal ${bars} of 4">${[1, 2, 3, 4].map((b) => `<i${b <= bars ? ' class="on"' : ''}></i>`).join('')}</span>
      </li>`;
  }).join('');
  list.hidden = !show;
  input.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show && wifi.cur >= 0) input.setAttribute('aria-activedescendant', `cf-wifi-o${wifi.cur}`); else input.removeAttribute('aria-activedescendant');
  if (show && wifi.cur >= 0) list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  btn.disabled = wifi.scanning;
  btn.textContent = wifi.scanning ? 'Scanning…' : 'Scan';
  if (wifi.scanning) note.textContent = 'Listening for networks (a few seconds)…';
  else if (wifi.error) note.textContent = wifi.error;
  else if (!wifi.nets) note.textContent = '';
  else if (!wifi.nets.length) note.textContent = 'No networks heard. A network that hides its name can be typed in.';
  else if (!rows.length) note.textContent = `None of the ${wifi.nets.length} networks in range matches: it's used as typed.`;
  else note.textContent = `${wifi.nets.length} network${wifi.nets.length === 1 ? '' : 's'} in range.`;
}

async function wifiScan() {
  if (wifi.scanning) return;
  wifi.scanning = true; wifi.error = '';
  wifiRender(false);
  try {
    const r = await api('/api/v1/system/wifiscan');
    wifi.nets = wifiGroup(r.networks);
  } catch (e) {
    wifi.error = `Couldn't scan: ${e.message}`;
    if (!wifi.nets) wifi.nets = null;
  }
  wifi.scanning = false;
  wifi.cur = -1;
  const input = wq('in');
  wifiRender(!!input && document.activeElement === input);
}

function wifiPick(i) {
  const n = wifiShown()[i], input = wq('in');
  if (!n || !input) return;
  input.value = n.ssid;
  wifi.typed = false; wifi.cur = -1;
  wifiRender(false);
  wifi.picking = true;
  input.dispatchEvent(new Event('input', { bubbles: true }));       // an edit, for the Save bar
  wifi.picking = false;
  wifiRender(false);
  if (n.security !== 'open') root.querySelector('[data-key="wlan0.psk"]')?.focus();
}

function wifiKey(e) {
  const list = wq('list');
  const open = list && !list.hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const rows = wifiShown();
    if (!rows.length) return;
    e.preventDefault();
    if (!open) wifi.cur = Math.max(wifi.cur, 0);
    else wifi.cur = (wifi.cur + (e.key === 'ArrowDown' ? 1 : -1) + rows.length + (wifi.cur < 0 && e.key === 'ArrowUp' ? 1 : 0)) % rows.length;
    wifiRender(true);
  } else if (e.key === 'Enter' && open && wifi.cur >= 0) {
    e.preventDefault();
    wifiPick(wifi.cur);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault(); e.stopPropagation();
    wifi.cur = -1;
    wifiRender(false);
  }
}

function wifiEvents(el) {
  el.addEventListener('focusin', (e) => {
    if (!e.target.matches || !e.target.matches('[data-wifi-in]')) return;
    wifi.typed = false; wifi.cur = -1;
    if (!wifi.nets && !wifi.scanning) wifiScan(); else wifiRender(true);
  });
  el.addEventListener('focusout', (e) => {
    if (e.target.matches && e.target.matches('[data-wifi-in]')) wifiRender(false);
  });
  el.addEventListener('keydown', (e) => { if (e.target.matches && e.target.matches('[data-wifi-in]')) wifiKey(e); });
  // mousedown, not click: the field keeps the focus
  el.addEventListener('mousedown', (e) => {
    const o = e.target.closest && e.target.closest('[data-wifi-pick]');
    if (!o) return;
    e.preventDefault();
    wifiPick(Number(o.dataset.wifiPick));
  });
}

function onEdit(e) {
  const t = e.target;
  if (t.dataset && 'wifiIn' in t.dataset && e.type === 'input' && !wifi.picking) { wifi.typed = true; wifi.cur = -1; wifiRender(true); }
  if (t.dataset && t.dataset.exp) { saveExperimental(t); return; }
  if (t.dataset && t.dataset.dev) { saveDevMode(t); return; }
  // DHCP toggles show / hide the static address fields
  const m = t.dataset && t.dataset.key && t.dataset.key.match(/^(eth0|wlan0)\.dhcp$/);
  if (m) root.querySelector(`[data-static="${m[1]}"]`).hidden = t.checked;
  if (t.dataset && t.dataset.src === 'type') {
    const list = formSources();
    rerenderSources(list);
    return;
  }
  st.savedNote = '';
  updateBar();
}

function onClick(e) {
  const b = e.target.closest('button, a');
  if (!b) return;

  if (b.hasAttribute('data-wifi-scan')) { wifiScan().then(() => { wq('in')?.focus(); }); return; }

  if (b.hasAttribute('data-logout-now')) {
    e.preventDefault();
    import('../auth.js').then((m) => m.logout());
    return;
  }

  if (b.dataset.goto) {
    e.preventDefault();
    document.getElementById(`cf-${b.dataset.goto}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `#/config/${b.dataset.goto}`);
    return;
  }

  if (b.dataset.sys) { sysAction(b); return; }
  if (b.dataset.flash) { flashAction(b); return; }
  if (b.dataset.bk) { backupAction(b); return; }

  if (b.hasAttribute('data-src-add')) {
    const list = formSources();
    list.push({ type: 'web', url: '', enabled: true, status: 'new' });
    rerenderSources(list);
    root.querySelectorAll('[data-src-row]')[list.length - 1]?.querySelector('input.input')?.focus();
    return;
  }
  if (b.hasAttribute('data-src-refresh')) { refreshLists(); return; }
  if (b.dataset.srcMove || b.hasAttribute('data-src-del')) {
    const row = b.closest('[data-src-row]');
    const rows = [...root.querySelectorAll('[data-src-row]')];
    const i = rows.indexOf(row);
    const list = formSources();
    if (b.hasAttribute('data-src-del')) list.splice(i, 1);
    else {
      const j = i + Number(b.dataset.srcMove);
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    }
    rerenderSources(list);
  }
}

async function refreshLists() {
  try {
    st.library = await api('/api/v1/library/refresh', { method: 'POST' });
    if (!dirtySections().includes('library')) renderLibraryOnly();
    st.savedNote = 'LIBRARY LISTS ARE BEING DOWNLOADED AGAIN';
    updateBar();
  } catch (e) {
    st.errors.library = e.message;
    showProblem('library');
  }
}

function renderLibraryOnly() {
  const old = root.querySelector('[data-sec="library"]');
  const t = document.createElement('div');
  t.innerHTML = librarySection();
  old.replaceWith(t.firstElementChild);
  watchNav();
}

function showProblem(id) {
  const sec = root.querySelector(`[data-sec="${id}"]`);
  if (!sec) return;
  const p = sec.querySelector('[data-problem]');
  const err = st.errors[id];
  const warn = st.warnings[id];
  p.className = `cf-problem${err ? ' error' : warn ? ' warning' : ''}`;
  p.textContent = err ? `Not saved: ${err}` : warn || '';
  sec.classList.toggle('has-error', !!err);
}

/* ----------------------------------------------------------------- save */

async function save() {
  const dirty = dirtySections();
  if (!dirty.length) return;
  st.saving = true;
  st.errors = {};
  st.warnings = {};
  updateBar();

  for (const id of dirty) {
    const sec = root.querySelector(`[data-sec="${id}"]`);
    try {
      const problem = SECTIONS[id] && SECTIONS[id].check ? SECTIONS[id].check(sec) : '';
      if (problem) throw new Error(problem);          // checked here first (e.g. passwords that don't match)
      if (id === 'library') {
        st.library = await putJson('/api/v1/library/sources', { sources: readSources() });
      } else {
        const r = await putJson(`/api/v1/settings/${id}`, SECTIONS[id].read(sec));
        st.saved[id] = r.settings;
        if (r.warning) st.warnings[id] = r.warning;
      }
    } catch (e) {
      st.errors[id] = e.message;
    }
    if (!root) return;
  }

  st.saving = false;
  // re-render the saved sections from the server's answer, keep the failed
  // ones as typed so they can be fixed
  for (const id of dirty) {
    if (st.errors[id]) continue;
    const old = root.querySelector(`[data-sec="${id}"]`);
    const t = document.createElement('div');
    if (id === 'library') t.innerHTML = librarySection();
    else {
      const def = SECTIONS[id];
      t.innerHTML = section(id, def.title, def.render(st.saved[id]), def.hint ? def.hint(st.saved[id]) : '', def.status ? def.status(st.saved[id]) : '');
    }
    old.replaceWith(t.firstElementChild);
  }
  for (const id of dirty) showProblem(id);
  watchNav();
  const failed = Object.keys(st.errors);
  if (failed.length) {
    root.querySelector(`[data-sec="${failed[0]}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    st.savedNote = `SAVED · ${dirty.map((d) => (NAV.find((n) => n.id === d) || { label: SECTIONS[d]?.title || d }).label).join(', ').toUpperCase()}`;
  }
  updateBar();
}
