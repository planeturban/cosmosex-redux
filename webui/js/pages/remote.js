// Remote (stage 7.3): the ST's keyboard, mouse and joystick from the browser,
// and its screen (screencast / screenshots).
//   POST /api/v1/keyboard {"type":"pc","code":<linux keycode>,"state":"down"|"up"}
//   POST /api/v1/mouse    {"type":"relative","x":dx,"y":dy} (-128..127)
//                         {"type":"buttonleft"|"buttonright","state":"down"|"up"}
//   GET  /app/screencast/getscreen    resolution byte, 16 palette words, 32000 bytes screen
//   GET  /app/screencast/do_screenshot, screenshot_query_vbl, screenshot_vbl_enable|disable
// Keys are sent as Linux key codes of the physical key (KeyboardEvent.code),
// exactly as a USB keyboard on the CosmosEx would send them. The joystick
// uses the app's keyboard joysticks (Config → Keyboard & joysticks): the
// arrow keys + Right Ctrl, or a gamepad, press that joystick's keys.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------- key code tables */

// KeyboardEvent.code -> Linux key code (input-event-codes.h)
const CODE_TO_LINUX = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  IntlBackslash: 43, F11: 87, F12: 88, NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111,
};

// key names as in the app's keyboard-joystick settings (keytranslator.cpp) -> Linux key code
const NAME_TO_LINUX = (() => {
  const m = {
    ESC: 1, '-': 12, '=': 13, BACKSPACE: 14, TAB: 15, '[': 26, ']': 27, ENTER: 28, LCTRL: 29, ';': 39, "'": 40, '#': 41,
    LSHIFT: 42, '\\': 43, ',': 51, '.': 52, '/': 53, RSHIFT: 54, KPASTERISK: 55, LALT: 56, ' ': 57, SPACE: 57, CAPS: 58,
    KPMINUS: 74, KPPLUS: 78, KPDOT: 83, KPENTER: 96, RCTRL: 97, KPSLASH: 98, RALT: 100, HOME: 102, UP: 103, LEFT: 105,
    RIGHT: 106, DOWN: 108, INSERT: 110, DELETE: 111, F11: 87, F12: 88,
  };
  '1234567890'.split('').forEach((d, i) => { m[d] = 2 + i; });
  'QWERTYUIOP'.split('').forEach((c, i) => { m[c] = 16 + i; });
  'ASDFGHJKL'.split('').forEach((c, i) => { m[c] = 30 + i; });
  'ZXCVBNM'.split('').forEach((c, i) => { m[c] = 44 + i; });
  for (let i = 1; i <= 10; i++) m[`F${i}`] = 58 + i;
  [[7, 71], [8, 72], [9, 73], [4, 75], [5, 76], [6, 77], [1, 79], [2, 80], [3, 81], [0, 82]].forEach(([n, c]) => { m[`KP${n}`] = c; });
  return m;
})();

// The ST keyboard, as Linux key codes. [label, code, width in key units]
const ST_MAIN = [
  [['F1', 59, 1.5], ['F2', 60, 1.5], ['F3', 61, 1.5], ['F4', 62, 1.5], ['F5', 63, 1.5], ['F6', 64, 1.5], ['F7', 65, 1.5], ['F8', 66, 1.5], ['F9', 67, 1.5], ['F10', 68, 1.5]],
  [['Esc', 1], ['1', 2], ['2', 3], ['3', 4], ['4', 5], ['5', 6], ['6', 7], ['7', 8], ['8', 9], ['9', 10], ['0', 11], ['-', 12], ['=', 13], ['Backspace', 14, 2]],
  [['Tab', 15, 1.5], ['Q', 16], ['W', 17], ['E', 18], ['R', 19], ['T', 20], ['Y', 21], ['U', 22], ['I', 23], ['O', 24], ['P', 25], ['[', 26], [']', 27], ['Return', 28, 1.5], ['Delete', 111]],
  [['Control', 29, 1.75], ['A', 30], ['S', 31], ['D', 32], ['F', 33], ['G', 34], ['H', 35], ['J', 36], ['K', 37], ['L', 38], [';', 39], ["'", 40], ['Return', 28, 1.25], ['~', 41]],
  [['Shift', 42, 1.25], ['\\', 43], ['Z', 44], ['X', 45], ['C', 46], ['V', 47], ['B', 48], ['N', 49], ['M', 50], [',', 51], ['.', 52], ['/', 53], ['Shift', 54, 2.75]],
  [['Alternate', 56, 2], ['Space', 57, 9], ['Caps Lock', 58, 2]],
];
const ST_SIDE = [
  [['Help', 87, 1.5], ['Undo', 88, 1.5]],
  [['Insert', 110], ['↑', 103], ['Clr Home', 102]],
  [['←', 105], ['↓', 108], ['→', 106]],
];
const MODIFIERS = new Set([29, 42, 54, 56]);      // Control, Shift, Alternate: latch on the on-screen keyboard

/* ------------------------------------------------------------- state */

let root = null;
let st = null;

const sendJson = (url, data) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => {});
const sendKey = (code, state) => sendJson('/api/v1/keyboard', { type: 'pc', code, state });
const sendButton = (type, state) => sendJson('/api/v1/mouse', { type, state });

export function mount(el) {
  root = el;
  st = {
    streaming: false, streamTimer: null, frameSeq: 0, fps: 0, frames: 0, fpsSince: 0,
    grabbed: false, dx: 0, dy: 0, moveTimer: null,
    down: new Set(), latched: new Set(),
    joyPort: 'off', joyKeys: null, joyEnabled: [false, false], joyPressed: new Set(), padTimer: null,
    lastKey: '—', res: -1,
  };

  el.innerHTML = `
    <header class="page-head">
      <div>
        <p class="eyebrow">IKBD injector · CE_CAST.PRG</p>
        <h1>Remote</h1>
        <p class="page-hint">Type and move the mouse on the ST from here. Click the screen to send keys and mouse; the screen picture needs CE_CAST.PRG (screencast) or CE_DD (screenshots) running on the ST.</p>
      </div>
    </header>

    <div class="rm">
      <section class="rm-screen-col" aria-label="ST screen">
        <div class="rm-toolbar">
          <button type="button" class="btn btn-primary" data-rm="stream" aria-pressed="false">Start screencast</button>
          <button type="button" class="btn btn-secondary" data-rm="grab" aria-pressed="false">Grab mouse</button>
          <button type="button" class="btn btn-secondary" data-rm="shot">Screenshot</button>
          <button type="button" class="btn btn-danger rm-cad" data-rm="cad">Ctrl+Alt+Del</button>
        </div>
        <div class="rm-screen" data-rm="screen" tabindex="0" data-noswipe aria-label="ST screen: click to send keyboard and mouse to the ST" role="application">
          <canvas data-rm="canvas" width="640" height="400" hidden></canvas>
          <div class="rm-idle" data-rm="idle">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><rect x="3" y="4" width="18" height="12"></rect><path d="M8 20h8M12 16v4"></path></svg>
            <span class="rm-idle-t">Screen not streaming</span>
            <span class="rm-idle-h">Start the screencast, or click here and type: keys and mouse go to the ST either way.</span>
          </div>
          <div class="rm-tags">
            <span class="rm-live" data-rm="live" hidden>● LIVE</span>
            <span class="rm-res mono" data-rm="resinfo" hidden></span>
          </div>
        </div>
        <p class="mono rm-under"><span data-rm="hint">click inside to send keys and mouse · Esc releases a mouse grab</span><span>last key: <span data-rm="lastkey">—</span></span></p>
        <p class="rm-msg" data-rm="msg" role="status" aria-live="polite"></p>
      </section>

      <aside class="rm-side">
        <section class="panel">
          <h2>Input</h2>
          <dl class="kv">
            <dt>IKBD injector</dt><dd data-rm="ikbd">—</dd>
            <dt>Mouse</dt><dd data-rm="mousestate">click the screen</dd>
            <dt>Keyboard</dt><dd>Browser → ST</dd>
          </dl>
        </section>
        <section class="panel">
          <h2>Joystick</h2>
          <div class="segmented" role="radiogroup" aria-label="Joystick port">
            <button type="button" role="radio" aria-checked="false" data-joy="0">Port 0</button>
            <button type="button" role="radio" aria-checked="false" data-joy="1">Port 1</button>
            <button type="button" role="radio" aria-checked="true" data-joy="off">Off</button>
          </div>
          <p class="hint rm-joyhint" data-rm="joyhint">Arrow keys + Right Ctrl (fire) on the screen, or a gamepad, act as the joystick. Uses the keyboard joysticks of Config → Keyboard &amp; joysticks.</p>
        </section>
        <section class="panel">
          <h2>Capture</h2>
          <label class="cf-check"><input type="checkbox" data-rm="vbl">Sync screenshots to VBL</label>
          <p class="hint">Screenshots need CE_DD on the ST; with VBL sync they're taken at the start of a frame (no tearing).</p>
        </section>
      </aside>
    </div>

    <section class="panel rm-kbd-panel" aria-labelledby="rm-kbd-h">
      <div class="section-head"><h2 id="rm-kbd-h">ST keyboard</h2><span class="hint mono">Control, Shift and Alternate stay down until the next key</span></div>
      <div class="rm-kbd-scroll" data-noswipe>
        <div class="rm-kbd" data-rm="kbd">
          <div class="rm-kbd-main">${ST_MAIN.map((r) => `<div class="rm-row">${r.map(key).join('')}</div>`).join('')}</div>
          <div class="rm-kbd-side">${ST_SIDE.map((r) => `<div class="rm-row">${r.map(key).join('')}</div>`).join('')}</div>
        </div>
      </div>
    </section>`;

  const screen = q('screen');
  screen.addEventListener('keydown', onKeyDown);
  screen.addEventListener('keyup', onKeyUp);
  screen.addEventListener('blur', releaseAll);
  screen.addEventListener('mousemove', onMouseMove);
  screen.addEventListener('mousedown', onMouseDown);
  screen.addEventListener('mouseup', onMouseUp);
  screen.addEventListener('contextmenu', (e) => e.preventDefault());
  screen.addEventListener('focus', () => { q('mousestate').textContent = st.grabbed ? 'grabbed' : 'over the screen'; });
  document.addEventListener('pointerlockchange', onLockChange);
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  q('kbd').addEventListener('pointerdown', onKbdDown);
  q('kbd').addEventListener('pointerup', onKbdUp);
  q('kbd').addEventListener('pointerleave', onKbdUp);

  loadVbl();
  loadJoySettings();
  pollInput();
}

export function unmount() {
  if (!st) return;
  stopStream();
  releaseAll();
  clearInterval(st.padTimer);
  clearTimeout(st.inputTimer);
  document.removeEventListener('pointerlockchange', onLockChange);
  if (document.pointerLockElement) document.exitPointerLock();
  root = null;
  st = null;
}

const q = (n) => root.querySelector(`[data-rm="${n}"]`);

function key([label, code, w = 1]) {
  return `<button type="button" class="rm-key${MODIFIERS.has(code) ? ' mod' : ''}" style="--w:${w}" data-code="${code}" aria-label="${esc(label)}">${esc(label)}</button>`;
}

function say(t) { if (root) q('msg').textContent = t; }

/* ------------------------------------------------------------ keyboard */

function joyCodeFor(e) {
  if (st.joyPort === 'off' || !st.joyKeys) return null;
  const k = st.joyKeys[Number(st.joyPort)];
  const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ControlRight: 'button' }[e.code];
  return dir ? NAME_TO_LINUX[k[dir]] : null;
}

function onKeyDown(e) {
  if (e.code === 'Escape' && st.grabbed) return;   // the browser releases the grab
  const code = joyCodeFor(e) ?? CODE_TO_LINUX[e.code];
  if (code == null) return;
  e.preventDefault();
  if (st.down.has(code)) return;                   // auto-repeat: the ST repeats keys itself
  st.down.add(code);
  sendKey(code, 'down');
  st.lastKey = e.key.length === 1 ? e.key.toUpperCase() : e.code;
  q('lastkey').textContent = st.lastKey;
}

function onKeyUp(e) {
  const code = joyCodeFor(e) ?? CODE_TO_LINUX[e.code];
  if (code == null) return;
  e.preventDefault();
  st.down.delete(code);
  sendKey(code, 'up');
}

// focus lost with keys held: let them go on the ST too
function releaseAll() {
  if (!st) return;
  for (const c of st.down) sendKey(c, 'up');
  st.down.clear();
  for (const c of st.joyPressed) sendKey(c, 'up');
  st.joyPressed.clear();
}

// on-screen ST keyboard: modifiers latch until the next normal key
function onKbdDown(e) {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  e.preventDefault();
  const code = Number(b.dataset.code);
  if (MODIFIERS.has(code)) {
    if (st.latched.has(code)) { st.latched.delete(code); sendKey(code, 'up'); b.classList.remove('on'); }
    else { st.latched.add(code); sendKey(code, 'down'); b.classList.add('on'); }
    return;
  }
  b.classList.add('pressed');
  b.dataset.down = '1';
  sendKey(code, 'down');
  q('lastkey').textContent = b.getAttribute('aria-label');
}

function onKbdUp(e) {
  for (const b of root ? root.querySelectorAll('.rm-key[data-down]') : []) {
    const code = Number(b.dataset.code);
    delete b.dataset.down;
    b.classList.remove('pressed');
    sendKey(code, 'up');
    for (const m of st.latched) sendKey(m, 'up');
    st.latched.clear();
    for (const k of root.querySelectorAll('.rm-key.on')) k.classList.remove('on');
  }
}

function ctrlAltDel() {
  // Control + Alternate + Delete: the ST's warm reset
  sendKey(29, 'down');
  setTimeout(() => sendKey(56, 'down'), 40);
  setTimeout(() => sendKey(111, 'down'), 80);
  setTimeout(() => sendKey(111, 'up'), 240);
  setTimeout(() => sendKey(56, 'up'), 280);
  setTimeout(() => sendKey(29, 'up'), 320);
  say('Sent Ctrl+Alt+Del (warm reset).');
}

/* --------------------------------------------------------------- mouse */

function onMouseMove(e) {
  if (st.grabbed) { st.dx += e.movementX; st.dy += e.movementY; }
  else if (e.buttons || document.activeElement === q('screen')) { st.dx += e.movementX; st.dy += e.movementY; }
  else return;
  if (!st.moveTimer) st.moveTimer = setTimeout(flushMove, 30);   // ~30 packets/s at most
}

function flushMove() {
  st.moveTimer = null;
  let { dx, dy } = st;
  st.dx = 0; st.dy = 0;
  while (dx || dy) {                                // the IKBD takes -128..127 per packet
    const x = Math.max(-128, Math.min(127, dx));
    const y = Math.max(-128, Math.min(127, dy));
    sendJson('/api/v1/mouse', { type: 'relative', x, y });
    dx -= x; dy -= y;
  }
}

function onMouseDown(e) {
  q('screen').focus();
  if (e.button === 0) sendButton('buttonleft', 'down');
  else if (e.button === 2) sendButton('buttonright', 'down');
  else return;
  e.preventDefault();
}

function onMouseUp(e) {
  if (e.button === 0) sendButton('buttonleft', 'up');
  else if (e.button === 2) sendButton('buttonright', 'up');
}

function toggleGrab() {
  if (document.pointerLockElement) document.exitPointerLock();
  else q('screen').requestPointerLock?.();
}

function onLockChange() {
  if (!root) return;
  st.grabbed = document.pointerLockElement === q('screen');
  const b = q('grab');
  b.setAttribute('aria-pressed', String(st.grabbed));
  b.textContent = st.grabbed ? 'Mouse grabbed' : 'Grab mouse';
  q('mousestate').textContent = st.grabbed ? 'grabbed (Esc releases)' : 'click the screen';
  if (st.grabbed) q('screen').focus();
}

/* ------------------------------------------------------------- screen */

function palette(dv) {
  // 16 words 0x0RGB: 3 bits per colour (ST), STE's extra bit is bit 3 (the LSB)
  const pal = [];
  for (let i = 0; i < 16; i++) {
    const w = dv.getUint16(1 + i * 2);
    const c = (v) => (((v & 7) << 1) | ((v >> 3) & 1)) * 17;
    pal.push([c(w >> 8), c(w >> 4), c(w)]);
  }
  return pal;
}

function draw(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength !== 32033) return false;
  const res = dv.getUint8(0);
  const canvas = q('canvas');
  const [w, h, planes] = res === 0 ? [320, 200, 4] : res === 1 ? [640, 200, 2] : [640, 400, 1];
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  canvas.classList.toggle('lowres', h === 200);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const pal = palette(dv);
  const mono = planes === 1;
  const inv = mono && (dv.getUint16(1) & 1);         // high res: colour 0 bit 0 inverts
  let src = 33, px = 0;
  const words = (w * h * planes) / 16;
  for (let i = 0; i < words; i += planes) {
    const pw = [];
    for (let p = 0; p < planes; p++) pw.push(dv.getUint16(src + (i + p) * 2));
    for (let bit = 15; bit >= 0; bit--) {
      let idx = 0;
      for (let p = 0; p < planes; p++) idx |= ((pw[p] >> bit) & 1) << p;
      const o = px * 4;
      if (mono) {
        const v = (idx ^ (inv ? 1 : 0)) ? 0 : 255;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      } else {
        const c = pal[idx];
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      }
      img.data[o + 3] = 255;
      px++;
    }
  }
  ctx.putImageData(img, 0, 0);
  canvas.hidden = false;
  q('idle').hidden = true;
  if (res !== st.res) {
    st.res = res;
    q('resinfo').hidden = false;
  }
  return true;
}

async function getScreen() {
  const r = await fetch(`/app/screencast/getscreen?${Date.now()}`, { cache: 'no-store' });
  return r.ok ? r.arrayBuffer() : null;
}

async function streamLoop() {
  if (!st || !st.streaming) return;
  try {
    const buf = await getScreen();
    if (buf && draw(buf)) {
      st.frames++;
      const now = performance.now();
      if (now - st.fpsSince > 1000) {
        st.fps = Math.round((st.frames * 1000) / (now - st.fpsSince));
        st.frames = 0; st.fpsSince = now;
        const c = q('canvas');
        q('resinfo').textContent = `${c.width}×${c.height} · ${st.fps} FPS`;
      }
    }
  } catch (e) { /* next frame */ }
  if (st && st.streaming) st.streamTimer = setTimeout(streamLoop, 100);
}

function startStream() {
  st.streaming = true;
  st.fpsSince = performance.now();
  st.frames = 0;
  const b = q('stream');
  b.setAttribute('aria-pressed', 'true');
  b.textContent = 'Stop screencast';
  b.classList.replace('btn-primary', 'btn-secondary');
  q('live').hidden = false;
  streamLoop();
}

function stopStream() {
  if (!st) return;
  st.streaming = false;
  clearTimeout(st.streamTimer);
  if (!root) return;
  const b = q('stream');
  b.setAttribute('aria-pressed', 'false');
  b.textContent = 'Start screencast';
  b.classList.replace('btn-secondary', 'btn-primary');
  q('live').hidden = true;
}

async function screenshot() {
  say('Taking a screenshot (needs CE_DD on the ST)…');
  try {
    await fetch('/app/screencast/do_screenshot', { method: 'POST', cache: 'no-store' });
    await new Promise((r) => setTimeout(r, 1200));   // the ST sends it within about a second
    const buf = await getScreen();
    if (!buf || !draw(buf)) { say('No screen from the ST: is CE_DD running?'); return; }
    const a = document.createElement('a');
    const t = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    a.download = `st-screenshot-${t}.png`;
    a.href = q('canvas').toDataURL('image/png');
    a.click();
    say(`Saved ${a.download}.`);
  } catch (e) {
    say(`Screenshot failed: ${e.message}`);
  }
}

async function loadVbl() {
  try {
    const r = await (await fetch('/app/screencast/screenshot_query_vbl', { cache: 'no-store' })).json();
    if (root) q('vbl').checked = !!r.screenShotVblEnabled;
  } catch (e) { /* leave unchecked */ }
}

/* ------------------------------------------------------------ joystick */

async function loadJoySettings() {
  try {
    const r = await (await fetch('/api/v1/settings/ikbd', { cache: 'no-store' })).json();
    st.joyKeys = r.keybJoyKeys;
    st.joyEnabled = [!!r.keybJoy0, !!r.keybJoy1];
  } catch (e) { st.joyKeys = null; }
}

function setJoy(port) {
  st.joyPort = port;
  for (const b of root.querySelectorAll('[data-joy]')) b.setAttribute('aria-checked', String(b.dataset.joy === port));
  releaseAll();
  clearInterval(st.padTimer);
  const hint = q('joyhint');
  if (port === 'off') {
    hint.innerHTML = 'Arrow keys + Right Ctrl (fire) on the screen, or a gamepad, act as the joystick. Uses the keyboard joysticks of Config → Keyboard &amp; joysticks.';
    return;
  }
  if (!st.joyKeys) { hint.textContent = 'Couldn\'t read the keyboard joystick settings.'; return; }
  const k = st.joyKeys[Number(port)];
  hint.innerHTML = st.joyEnabled[Number(port)]
    ? `Joystick ${port}: arrow keys + Right Ctrl on the screen (sent as ${esc([k.up, k.down, k.left, k.right, k.button].join(' '))}), or a gamepad.`
    : `Keyboard joystick ${port} is off on the CosmosEx: turn on “Use keys as joystick ${port}” in <a href="#/config/ikbd">Config → Keyboard &amp; joysticks</a>.`;
  st.padTimer = setInterval(pollPad, 16);
}

// first connected gamepad: d-pad / left stick and button 0 press the joystick's keys
function pollPad() {
  if (!st || st.joyPort === 'off' || !st.joyKeys) return;
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  if (!pads.length) return;
  const p = pads[0];
  const k = st.joyKeys[Number(st.joyPort)];
  const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
  const btn = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
  const want = new Set();
  if (ay < -0.5 || btn(12)) want.add(NAME_TO_LINUX[k.up]);
  if (ay > 0.5 || btn(13)) want.add(NAME_TO_LINUX[k.down]);
  if (ax < -0.5 || btn(14)) want.add(NAME_TO_LINUX[k.left]);
  if (ax > 0.5 || btn(15)) want.add(NAME_TO_LINUX[k.right]);
  if (btn(0) || btn(1)) want.add(NAME_TO_LINUX[k.button]);
  want.delete(undefined);
  for (const c of want) if (!st.joyPressed.has(c)) { st.joyPressed.add(c); sendKey(c, 'down'); }
  for (const c of [...st.joyPressed]) if (!want.has(c)) { st.joyPressed.delete(c); sendKey(c, 'up'); }
}

/* --------------------------------------------------------------- input */

async function pollInput() {
  if (!st) return;
  try {
    const s = await (await fetch('/api/v1/status', { cache: 'no-store' })).json();
    if (root) {
      const franz = s.chips && s.chips.franz && s.chips.franz.ok;
      q('ikbd').innerHTML = franz ? '<span class="dot dot-ok" aria-hidden="true"></span> connected' : '<span class="dot dot-bad" aria-hidden="true"></span> Franz not answering';
    }
  } catch (e) { /* the shell's connection bar shows it */ }
  if (st) st.inputTimer = setTimeout(pollInput, 5000);
}

/* -------------------------------------------------------------- clicks */

function onClick(e) {
  const b = e.target.closest('[data-rm], [data-joy]');
  if (!b) return;
  if (b.dataset.joy) { setJoy(b.dataset.joy); return; }
  switch (b.dataset.rm) {
    case 'stream': if (st.streaming) stopStream(); else startStream(); break;
    case 'grab': toggleGrab(); break;
    case 'shot': screenshot(); break;
    case 'cad': ctrlAltDel(); break;
    default: break;
  }
}

function onChange(e) {
  if (e.target.dataset.rm === 'vbl') {
    const on = e.target.checked;
    fetch(`/app/screencast/screenshot_vbl_${on ? 'enable' : 'disable'}`, { method: 'POST', cache: 'no-store' })
      .then(() => say(on ? 'Screenshots are synced to VBL.' : 'Screenshots are no longer synced to VBL.'))
      .catch(() => say('Couldn\'t change the VBL setting.'));
  }
}
