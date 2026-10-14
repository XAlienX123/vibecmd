'use strict';

/*
 * Docking app windows on KDE Plasma 6 under Wayland. There, only the
 * compositor can move or hide other apps' windows, so the work is done by a
 * KWin script (native/kwindock.kwin.js) that this loads into KWin. Speaks the
 * same line protocol as linuxdock.js and native/winhelper.cs, so main.js and
 * the renderer treat all three alike.
 *
 * The script and this talk over the session D-Bus. Node has no D-Bus of its
 * own, so the little of the protocol needed (calls and replies with string,
 * int and bool values) is spoken directly over the bus socket below.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { quote, splitArgs } = require('./linuxdock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

// ---------------------------------------------------------------- d-bus

const CALL = 1;
const RETURN = 2;
const ERROR = 3;

// Builds the bytes of values, aligned as D-Bus wants (from the message start).
function writer() {
  const b = [];
  const pad = (n) => { while (b.length % n) b.push(0); };
  const u32 = (v) => { pad(4); b.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
  const bytes = (d) => { for (const x of d) b.push(x); };
  const str = (s) => { const d = Buffer.from(s, 'utf8'); u32(d.length); bytes(d); b.push(0); };
  const sig = (s) => { b.push(s.length); bytes(Buffer.from(s)); b.push(0); };
  const value = (t, v) => {
    if (t === 's' || t === 'o') str(v);
    else if (t === 'g') sig(v);
    else if (t === 'u' || t === 'i' || t === 'b') u32(t === 'b' ? (v ? 1 : 0) : v);
  };
  return { b, pad, u32, sig, value };
}

// fields: [code, type, value]; codes: 1 path, 2 interface, 3 member,
// 5 reply serial, 6 destination, 8 signature.
function message(type, serial, fields, sig = '', args = []) {
  const body = writer();
  for (let i = 0; i < sig.length; i++) body.value(sig[i], args[i]);
  const all = sig ? [...fields, [8, 'g', sig]] : fields;
  const h = writer();
  h.b.push(0x6c, type, 0, 1);
  h.u32(body.b.length);
  h.u32(serial);
  h.u32(0);
  const lenAt = h.b.length - 4;
  const start = h.b.length; // 16, already 8-aligned
  for (const [code, t, v] of all) {
    h.pad(8);
    h.b.push(code);
    h.sig(t);
    h.value(t, v);
  }
  const len = h.b.length - start;
  h.b.splice(lenAt, 4, len & 255, (len >>> 8) & 255, (len >>> 16) & 255, (len >>> 24) & 255);
  h.pad(8);
  return Buffer.from([...h.b, ...body.b]);
}

// Reads one whole message: { type, serial, fields, args }. Only the types
// above are read in a body; a value of any other type ends it.
function parse(m) {
  let p = 0;
  const align = (n) => { p = Math.ceil(p / n) * n; };
  const u32 = () => { align(4); const v = m.readUInt32LE(p); p += 4; return v; };
  const str = () => { const n = u32(); const s = m.toString('utf8', p, p + n); p += n + 1; return s; };
  const sig = () => { const n = m[p]; const s = m.toString('latin1', p + 1, p + 1 + n); p += n + 2; return s; };
  const value = (t) => {
    if (t === 's' || t === 'o') return str();
    if (t === 'g') return sig();
    if (t === 'u') return u32();
    if (t === 'i') { const v = u32(); return v | 0; }
    if (t === 'b') return u32() !== 0;
    throw new Error(`can't read ${t}`);
  };
  const type = m[1];
  const serial = m.readUInt32LE(8);
  const end = 16 + m.readUInt32LE(12);
  p = 16;
  const fields = {};
  while (p < end) {
    align(8);
    const code = m[p++];
    fields[code] = value(sig());
  }
  align(8);
  const args = [];
  try {
    for (const t of fields[8] || '') args.push(value(t));
  } catch { /* a type this doesn't read */ }
  return { type, serial, fields, args };
}

// The session bus: { name, call(dest, path, iface, member, sig, args), end() }.
// `onCall(member, args)` answers calls made to us; what it returns (or
// resolves with), if a string, is the reply.
function connectBus(onCall) {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`;
  const unix = addr.split(';').find((a) => a.startsWith('unix:')) || '';
  const opts = Object.fromEntries(unix.slice(5).split(',').map((kv) => kv.split('=')));
  const where = opts.path || (opts.abstract && `\0${opts.abstract}`);
  if (!where) return Promise.reject(new Error(`can't use bus address ${addr}`));

  return new Promise((resolve, reject) => {
    const sock = net.createConnection(where);
    const waiting = new Map(); // serial -> { resolve, reject }
    let serial = 1;
    let buf = Buffer.alloc(0);
    let authed = false;

    const call = (dest, objPath, iface, member, sig = '', args = []) => new Promise((ok, fail) => {
      const n = serial++;
      waiting.set(n, { resolve: ok, reject: fail });
      sock.write(message(CALL, n, [[1, 'o', objPath], [2, 's', iface], [3, 's', member], [6, 's', dest]], sig, args));
    });

    async function answer(msg) {
      let out;
      try { out = await onCall(msg.fields[3], msg.args); } catch { /* answered empty */ }
      const fields = [[5, 'u', msg.serial], [6, 's', msg.fields[7]]];
      if (!sock.destroyed) sock.write(typeof out === 'string' ? message(RETURN, serial++, fields, 's', [out]) : message(RETURN, serial++, fields));
    }

    function onMessage(msg) {
      if (msg.type === CALL) { answer(msg); return; }
      const w = waiting.get(msg.fields[5]);
      if (!w) return;
      waiting.delete(msg.fields[5]);
      if (msg.type === ERROR) w.reject(new Error(msg.args[0] || msg.fields[4]));
      else if (msg.type === RETURN) w.resolve(msg.args[0]);
    }

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!authed) {
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.toString('latin1', 0, nl);
        buf = buf.subarray(nl + 2);
        if (!line.startsWith('OK')) { sock.destroy(); reject(new Error(`bus said ${line}`)); return; }
        authed = true;
        sock.write('BEGIN\r\n');
        call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'Hello')
          .then((name) => resolve({ name, call, end: () => sock.destroy() }), reject);
      }
      while (buf.length >= 16) {
        const fieldsLen = buf.readUInt32LE(12);
        const total = Math.ceil((16 + fieldsLen) / 8) * 8 + buf.readUInt32LE(4);
        if (buf.length < total) break;
        const msg = buf.subarray(0, total);
        buf = buf.subarray(total);
        try { onMessage(parse(msg)); } catch { /* not one we can read */ }
      }
    });
    sock.on('error', (err) => { if (!authed) reject(err); });
    sock.on('close', () => {
      for (const w of waiting.values()) w.reject(new Error('bus closed'));
      waiting.clear();
    });
    sock.on('connect', () => {
      sock.write(`\0AUTH EXTERNAL ${Buffer.from(String(process.getuid())).toString('hex')}\r\n`);
    });
  });
}

// ---------------------------------------------------------------- dock

const SCRIPT = 'vibecmd-dock';

// Runs a loaded script. Its object path changed in Plasma 6.
async function runScript(bus, id) {
  try {
    await bus.call('org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run');
  } catch {
    await bus.call('org.kde.KWin', `/${id}`, 'org.kde.kwin.Script', 'run');
  }
}

// `emit(line)`: a line for main.js's onHelperLine. `dir`: where to write the
// script KWin loads. Resolves null if KWin isn't there or won't run it.
async function createKwinDock({ emit, dir }) {
  const queue = []; // commands for the script
  let poll = null; // { reply, timer }: the script's Poll call, held until there are commands
  const waiters = new Map(); // key -> resolve
  const docked = new Map(); // id -> { closing }
  let onReady = null;

  const flush = () => {
    if (!poll || !queue.length) return;
    const p = poll;
    poll = null;
    clearTimeout(p.timer);
    p.reply(JSON.stringify(queue.splice(0)));
  };
  // Many places for one window in a row (VibeCMD being resized, say) only need
  // the last.
  const send = (c) => {
    if (c.cmd === 'place') {
      const i = queue.findIndex((q) => q.cmd === 'place' && q.id === c.id);
      if (i >= 0) queue.splice(i, 1);
    }
    queue.push(c);
    flush();
  };
  const ask = (c, key, timeout) => new Promise((resolve) => {
    waiters.set(key, resolve);
    send(c);
    if (timeout) setTimeout(() => { if (waiters.delete(key)) resolve(null); }, timeout);
  });
  const answer = (key, value) => {
    const w = waiters.get(key);
    if (w) { waiters.delete(key); w(value); }
  };

  function onEvent(ev) {
    switch (ev.ev) {
      case 'ready': onReady?.(); break;
      case 'windows': answer('windows', ev.list); break;
      case 'embedded': answer(`embed ${ev.id}`, ev); break;
      case 'launch': answer(`launch ${ev.id}`, ev.win); break;
      case 'released': answer(`release ${ev.id}`, true); break;
      case 'released-all': answer('release-all', true); break;
      case 'cursor': answer(`cursor ${ev.id}`, ev.outside); break;
      case 'error': if (ev.id != null) answer(`embed ${ev.id}`, null); break;
      case 'title': emit(`title ${ev.id} ${String(ev.title).replace(/\s+/g, ' ').trim()}`); break;
      case 'focus': emit(`focus ${ev.id}`); break;
      case 'gone': {
        const w = docked.get(ev.id);
        docked.delete(ev.id);
        answer(`gone ${ev.id}`, true);
        if (w && !w.closing) emit(`gone ${ev.id}`);
        break;
      }
    }
  }

  function onCall(member, args) {
    if (member === 'Emit') {
      try { onEvent(JSON.parse(args[0])); } catch { /* not for us */ }
      return undefined;
    }
    if (member === 'Poll') {
      // A second poll replaces the first, which gets nothing to do.
      if (poll) { clearTimeout(poll.timer); poll.reply('[]'); }
      return new Promise((reply) => {
        poll = { reply, timer: setTimeout(() => { poll = null; reply('[]'); }, 10000) };
        flush();
      });
    }
    return undefined;
  }

  let bus;
  try {
    bus = await connectBus(onCall);
    const call = (...a) => bus.call('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', ...a);
    if (!await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', ['org.kde.KWin'])) throw new Error('no KWin');
    const file = path.join(dir, 'kwin-dock.js');
    const source = fs.readFileSync(path.join(__dirname, 'native', 'kwindock.kwin.js'), 'utf8')
      .replace('%SERVICE%', bus.name)
      .replace('%PID%', String(process.pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, source);
    // One left over from a VibeCMD that didn't get to stop it.
    await call('unloadScript', 's', [SCRIPT]).catch(() => {});
    const id = await call('loadScript', 'ss', [file, SCRIPT]);
    if (id < 0) throw new Error('KWin would not load the script');
    const ready = new Promise((r) => { onReady = r; });
    await runScript(bus, id);
    if (!await Promise.race([ready.then(() => true), sleep(5000).then(() => false)])) throw new Error('the script never started');
  } catch {
    bus?.end();
    return null;
  }

  async function embed(id) {
    const res = await ask({ cmd: 'embed', id }, `embed ${id}`, 5000);
    if (!res?.ok) { emit(`error ${id} can't dock that window`); return; }
    if (!docked.has(id)) docked.set(id, { closing: false });
    // What starts it again next time: its process's command line.
    let exe = '';
    let args = '';
    try {
      const argv = fs.readFileSync(`/proc/${res.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      exe = argv[0] || '';
      args = argv.slice(1).map(quote).join(' ');
    } catch { /* no process to ask */ }
    emit(`embedded ${id} ${b64({ title: res.title, app: true, exe, args })}`);
  }

  // Asks the window to close, as its close button would. Resolves false if it's
  // still there after a minute (the app's save question was cancelled, say).
  async function closeWindow(id, timeout = 60000) {
    const w = docked.get(id);
    if (w) w.closing = true;
    const gone = await ask({ cmd: 'close', id }, `gone ${id}`, timeout);
    if (!gone && w) w.closing = false;
    return !!gone;
  }

  async function launch(id, spec) {
    const { exe, args } = JSON.parse(Buffer.from(spec, 'base64').toString('utf8'));
    let failed = false;
    const child = spawn(exe, splitArgs(args), { detached: true, stdio: 'ignore' });
    child.on('error', () => { failed = true; });
    child.unref();
    await sleep(0);
    if (failed) { emit(`launch ${id} 0`); return; }
    const cls = path.basename(exe).toLowerCase();
    const win = await ask({ cmd: 'launch', id: +id, pid: child.pid, cls }, `launch ${id}`, 15000);
    if (!win) send({ cmd: 'launch-cancel', id: +id });
    emit(`launch ${id} ${win || 0}`);
  }

  async function closeApps() {
    for (const id of [...docked.keys()]) {
      emit(`reveal ${id}`);
      await sleep(150);
      if (!await closeWindow(id)) { emit('apps-kept 0'); return; }
    }
    emit('closed-apps 0');
  }

  function command(line) {
    const a = line.split(' ');
    const id = a[1];
    switch (a[0]) {
      case 'embed': embed(id); break;
      case 'place': send({ cmd: 'place', id, x: +a[2], y: +a[3], w: +a[4], h: +a[5] }); break;
      case 'hide': send({ cmd: 'hide', id }); break;
      case 'focus': send({ cmd: 'focus', id }); break;
      case 'launch': launch(id, a[2]).catch(() => emit(`launch ${id} 0`)); break;
      case 'release':
        docked.delete(id);
        ask({ cmd: 'release', id }, `release ${id}`, 3000).then(() => emit(`released ${id}`));
        break;
      case 'close': if (docked.has(id)) closeWindow(id, 5000); break;
      case 'close-app':
        if (!docked.has(id)) emit(`close-app ${id} 1`);
        else closeWindow(id).then((ok) => emit(`close-app ${id} ${ok ? 1 : 0}`));
        break;
      case 'close-apps': closeApps(); break;
      case 'release-all':
        docked.clear();
        ask({ cmd: 'release-all' }, 'release-all', 3000).then(() => emit('released-all 0'));
        break;
      case 'close-all': emit('closed-all 0'); break;
    }
  }

  let nextCursor = 1;
  return {
    command,
    // Positions are in logical pixels, and KWin moves docked windows along
    // with VibeCMD by itself.
    logical: true,
    reposition: () => {},
    list: () => ask({ cmd: 'list' }, 'windows', 3000),
    // Whether the mouse is outside VibeCMD (Wayland doesn't tell apps where it is).
    cursorOutside: () => { const n = nextCursor++; return ask({ cmd: 'cursor', id: n }, `cursor ${n}`, 1000); },
    // The script gives every window back itself when VibeCMD's window goes.
    dispose: () => { send({ cmd: 'stop' }); bus.end(); },
    has: (id) => docked.has(id),
  };
}

module.exports = { createKwinDock };
