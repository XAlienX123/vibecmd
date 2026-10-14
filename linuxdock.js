'use strict';

/*
 * Docking app windows on Linux (X11, and XWayland windows under Wayland).
 * Does for Linux what native/winhelper.cs does for Windows, and speaks the same
 * line protocol, so main.js and the renderer treat both alike.
 *
 * A window can't be made a child of VibeCMD's here without native code, so a
 * docked window is borrowed instead: it loses its title bar, is marked as
 * belonging to VibeCMD's window (so it stays on top of it and goes with it),
 * and is moved and sized to lie over its pane. It follows VibeCMD when that
 * moves. Needs xdotool and xprop; wmctrl is used to close windows politely if
 * it's there. Windows of native Wayland apps can't be moved by anyone but the
 * compositor, so under Wayland this is only used when VibeCMD itself runs on
 * XWayland; on KDE Plasma under Wayland, kwindock.js docks through KWin
 * instead. Dragging a window in (holding Shift) is watched by native/linuxdrag.py.
 */

const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves with the command's output, or null if it failed.
function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, out) => resolve(err ? null : out));
  });
}

const xdo = (...args) => run('xdotool', args);
const ids = (out) => (out || '').split('\n').filter(Boolean);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

function splitArgs(text) {
  const out = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text || ''))) out.push(m[1] ?? m[2]?.replace(/\\(.)/g, '$1') ?? m[3]);
  return out;
}

async function available() {
  return (await xdo('version')) !== null && (await run('xprop', ['-version'])) !== null;
}

// The windows that could be docked, for the "Dock a window" menu.
async function listWindows(self) {
  const list = [];
  for (const id of ids(await xdo('search', '--onlyvisible', '--name', '.'))) {
    if (+id === self) continue;
    const [name, type] = await Promise.all([xdo('getwindowname', id), run('xprop', ['-id', id, '_NET_WM_WINDOW_TYPE'])]);
    if (!name?.trim()) continue;
    if (type && /DOCK|DESKTOP|NOTIFICATION|TOOLTIP|MENU|SPLASH|DND/.test(type)) continue;
    list.push({ id, title: name.trim() });
  }
  return list;
}

// Dragging a window onto VibeCMD. native/linuxdrag.py reports the mouse; a press
// on another window that moves it is that window being dragged, reported the way
// native/winhelper.cs reports a Windows one: drag-move / drag-end, and over VibeCMD
// only while Shift is held.
function watchDrags({ emit, origin, self, isDocked }) {
  const watcher = spawn('python3', [path.join(__dirname, 'native', 'linuxdrag.py')], { stdio: ['ignore', 'pipe', 'ignore'] });
  // No python3: no drag-in here, but docking from the window list still works.
  watcher.on('error', () => {});
  let press = null; // the window pressed, if it can be docked
  let dragging = false;
  const inside = (x, y) => {
    const o = origin();
    return x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;
  };
  function onLine(text) {
    const f = text.split(' ');
    if (f[0] === 'press') {
      press = f[2] !== '0' && +f[2] !== self && !isDocked(f[2]) ? f[2] : null;
      dragging = false;
      return;
    }
    if (!press) return;
    if (f[4] === '1') dragging = true;
    if (!dragging) return;
    const x = +f[1];
    const y = +f[2];
    const over = f[3] === '1' && inside(x, y) ? 1 : 0;
    if (f[0] === 'move') {
      emit(`drag-move ${press} ${x} ${y} ${over}`);
    } else {
      emit(`drag-end ${press} ${x} ${y} ${over}`);
      press = null;
      dragging = false;
    }
  }
  let buf = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  return { stop: () => watcher.kill() };
}

// `emit(line)`: a line for main.js's onHelperLine. `origin()`: where the top
// left of VibeCMD's page is on the screen, and its size, in pixels. `self`:
// VibeCMD's window id.
function createLinuxDock({ emit, origin, self }) {
  const docked = new Map(); // id -> { id, title, rel, shown, last, q, closing, saved }
  const selfHex = `0x${self.toString(16)}`;

  const later = (w, fn) => { w.q = w.q.then(fn).catch(() => {}); };
  const exists = async (id) => (await xdo('getwindowname', id)) !== null;

  async function embed(id) {
    const title = (await xdo('getwindowname', id))?.trim();
    if (title == null || +id === self) { emit(`error ${id} can't dock that window`); return; }
    let w = docked.get(id);
    if (!w) {
      const geo = Object.fromEntries((await xdo('getwindowgeometry', '--shell', id) || '').split('\n').map((l) => l.split('=')));
      w = { id, title, rel: null, shown: false, last: '', q: Promise.resolve(), closing: false, geo };
      docked.set(id, w);
      await xdo('windowunmap', id);
      await run('xprop', ['-id', id, '-f', '_MOTIF_WM_HINTS', '32c', '-set', '_MOTIF_WM_HINTS', '2, 0, 0, 0, 0']);
      await run('xprop', ['-id', id, '-f', 'WM_TRANSIENT_FOR', '32x', '-set', 'WM_TRANSIENT_FOR', selfHex]);
    }
    // What starts it again next time: its process's command line.
    const pid = +(await xdo('getwindowpid', id)) || 0;
    let exe = '';
    let args = '';
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      exe = argv[0] || '';
      args = argv.slice(1).map(quote).join(' ');
    } catch { /* no process to ask */ }
    emit(`embedded ${id} ${b64({ title, app: true, exe, args })}`);
  }

  function apply(w) {
    if (!w.rel) return;
    const o = origin();
    const [x, y, wd, h] = w.rel;
    const at = `${Math.round(o.x + x)} ${Math.round(o.y + y)} ${wd} ${h}`;
    if (w.shown && w.last === at) return;
    w.shown = true;
    w.last = at;
    const [ax, ay] = at.split(' ');
    later(w, () => xdo('windowsize', w.id, `${wd}`, `${h}`, 'windowmove', w.id, ax, ay, 'windowmap', w.id, 'windowraise', w.id));
  }

  function place(id, x, y, wd, h) {
    const w = docked.get(id);
    if (!w) return;
    w.rel = [x, y, wd, h];
    apply(w);
  }

  function hide(id) {
    const w = docked.get(id);
    if (!w || !w.shown) return;
    w.shown = false;
    w.last = '';
    later(w, () => xdo('windowunmap', w.id));
  }

  async function release(w) {
    docked.delete(w.id);
    await w.q;
    await run('xprop', ['-id', w.id, '-remove', 'WM_TRANSIENT_FOR']);
    await run('xprop', ['-id', w.id, '-f', '_MOTIF_WM_HINTS', '32c', '-set', '_MOTIF_WM_HINTS', '2, 0, 1, 0, 0']);
    const g = w.geo || {};
    await xdo('windowmove', w.id, g.X || '100', g.Y || '100', 'windowsize', w.id, g.WIDTH || '800', g.HEIGHT || '600', 'windowmap', w.id);
  }

  // Asks the window to close, as its close button would. Resolves false if it's
  // still there after a minute (the app's save question was cancelled, say).
  async function closeWindow(w, timeout = 60000) {
    w.closing = true;
    if ((await run('wmctrl', ['-ic', w.id])) === null) await xdo('windowquit', w.id);
    for (let t = 0; t < timeout; t += 250) {
      if (!(await exists(w.id))) { docked.delete(w.id); return true; }
      await sleep(250);
    }
    w.closing = false;
    return false;
  }

  async function launch(id, spec) {
    const { exe, args } = JSON.parse(Buffer.from(spec, 'base64').toString('utf8'));
    const before = new Set(ids(await xdo('search', '--onlyvisible', '--name', '.')));
    let failed = false;
    const child = spawn(exe, splitArgs(args), { detached: true, stdio: 'ignore' });
    child.on('error', () => { failed = true; });
    child.unref();
    const cls = path.basename(exe).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (let t = 0; t < 15000 && !failed; t += 250) {
      await sleep(250);
      let found = ids(await xdo('search', '--onlyvisible', '--pid', `${child.pid}`));
      if (!found.length) found = ids(await xdo('search', '--onlyvisible', '--class', cls)).filter((i) => !before.has(i));
      const pick = found.find((i) => !docked.has(i) && !before.has(i));
      if (pick) { emit(`launch ${id} ${pick}`); return; }
    }
    emit(`launch ${id} 0`);
  }

  async function closeApps() {
    for (const w of [...docked.values()]) {
      emit(`reveal ${w.id}`);
      await sleep(150);
      if (!await closeWindow(w)) { emit('apps-kept 0'); return; }
    }
    emit('closed-apps 0');
  }

  // Titles, windows that closed by themselves, and the keyboard going into one.
  let activeId = '';
  const tick = setInterval(async () => {
    for (const w of [...docked.values()]) {
      if (w.closing) continue;
      const title = (await xdo('getwindowname', w.id))?.trim();
      if (title == null) {
        docked.delete(w.id);
        emit(`gone ${w.id}`);
      } else if (title !== w.title) {
        w.title = title;
        emit(`title ${w.id} ${title}`);
      }
    }
    const now = ((await xdo('getactivewindow')) || '').trim();
    if (now !== activeId) {
      activeId = now;
      if (docked.has(now)) emit(`focus ${now}`);
    }
  }, 800);

  function command(line) {
    const a = line.split(' ');
    const id = a[1];
    switch (a[0]) {
      case 'embed': embed(id); break;
      case 'place': place(id, +a[2], +a[3], +a[4], +a[5]); break;
      case 'hide': hide(id); break;
      case 'focus': xdo('windowactivate', id); break;
      case 'launch': launch(id, a[2]).catch(() => emit(`launch ${id} 0`)); break;
      case 'release': { const w = docked.get(id); if (w) release(w).then(() => emit(`released ${id}`)); break; }
      case 'close': { const w = docked.get(id); if (w) closeWindow(w, 5000); break; }
      case 'close-app': {
        const w = docked.get(id);
        if (!w) emit(`close-app ${id} 1`);
        else closeWindow(w).then((ok) => emit(`close-app ${id} ${ok ? 1 : 0}`));
        break;
      }
      case 'close-apps': closeApps(); break;
      case 'release-all': Promise.all([...docked.values()].map(release)).then(() => emit('released-all 0')); break;
      case 'close-all': emit('closed-all 0'); break;
    }
  }

  // VibeCMD moved or resized: windows follow.
  const reposition = () => { for (const w of docked.values()) { w.last = ''; apply(w); } };

  // Nothing may stay hidden and without a title bar when VibeCMD is gone.
  const drags = watchDrags({ emit, origin, self, isDocked: (id) => docked.has(id) });

  function dispose() {
    clearInterval(tick);
    drags.stop();
    for (const w of docked.values()) {
      const g = w.geo || {};
      for (const args of [
        ['-id', w.id, '-remove', 'WM_TRANSIENT_FOR'],
        ['-id', w.id, '-f', '_MOTIF_WM_HINTS', '32c', '-set', '_MOTIF_WM_HINTS', '2, 0, 1, 0, 0'],
      ]) {
        try { execFileSync('xprop', args, { timeout: 2000 }); } catch { /* gone already */ }
      }
      try { execFileSync('xdotool', ['windowmove', w.id, g.X || '100', g.Y || '100', 'windowmap', w.id], { timeout: 2000 }); } catch { /* gone already */ }
    }
    docked.clear();
  }

  return { command, reposition, dispose, has: (id) => docked.has(id) };
}

module.exports = { createLinuxDock, listWindows, available, quote, splitArgs };
