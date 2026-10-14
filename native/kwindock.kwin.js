// KWin script for VibeCMD's docking on KDE Plasma 6 under Wayland (see
// kwindock.js, which fills in the two values below and loads it into KWin).
// Under Wayland only the compositor can move other apps' windows, so this does
// for KWin what linuxdock.js does with xdotool on X11.
//
// It talks to VibeCMD over D-Bus: Emit(json) reports something, and Poll()
// is answered with a JSON list of commands once there are some (or after a
// while with none, so the call never times out). Positions are in logical
// pixels, relative to the top left of VibeCMD's page.
const SERVICE = '%SERVICE%';
const PID = %PID%;
const IFACE = 'io.github.xalienx123.VibeCMD';

const docked = {}; // id -> { w, rel, shown, saved, onCaption }
const launches = {}; // launch id -> { pid, cls }
let self = null;
let stopped = false;

const idOf = (w) => String(w.internalId);
const windows = () => workspace.windowList();
const emit = (ev) => callDBus(SERVICE, '/', IFACE, 'Emit', JSON.stringify(ev));
const find = (id) => windows().find((w) => idOf(w) === id) || null;
const isSelf = (w) => w.pid === PID && w.normalWindow && !w.transient;
const dockable = (w) => w.normalWindow && !w.transient && w.pid !== PID && !!w.caption;
const rect = (g) => ({ x: g.x, y: g.y, width: g.width, height: g.height });

function apply(d) {
  if (!self || !d.rel || !d.shown) return;
  const c = self.clientGeometry;
  d.w.frameGeometry = { x: c.x + d.rel.x, y: c.y + d.rel.y, width: d.rel.width, height: d.rel.height };
  if (d.w.minimized) d.w.minimized = false;
}

// Docked windows sit just above VibeCMD, so they come up with it.
function raiseDocked() {
  for (const id in docked) if (docked[id].shown) workspace.raiseWindow(docked[id].w);
}

function adopt(w) {
  self = w;
  w.frameGeometryChanged.connect(() => { for (const id in docked) apply(docked[id]); });
  w.minimizedChanged.connect(() => {
    for (const id in docked) {
      const d = docked[id];
      if (!d.shown) continue;
      if (w.minimized) d.w.minimized = true;
      else apply(d);
    }
  });
  w.desktopsChanged.connect(() => { for (const id in docked) docked[id].w.desktops = w.desktops; });
}

function embed(id) {
  const w = find(id);
  if (!w || w === self || !self) { emit({ ev: 'embedded', id, ok: false }); return; }
  if (!docked[id]) {
    const d = {
      w,
      rel: null,
      shown: false,
      saved: { noBorder: w.noBorder, skipTaskbar: w.skipTaskbar, skipSwitcher: w.skipSwitcher, skipPager: w.skipPager, geo: rect(w.frameGeometry) },
      onCaption: () => emit({ ev: 'title', id, title: w.caption }),
    };
    docked[id] = d;
    w.noBorder = true;
    w.skipTaskbar = true;
    w.skipSwitcher = true;
    w.skipPager = true;
    w.desktops = self.desktops;
    w.minimized = true;
    w.captionChanged.connect(d.onCaption);
  }
  emit({ ev: 'embedded', id, ok: true, pid: w.pid, title: w.caption });
}

function release(id) {
  const d = docked[id];
  if (!d) return;
  delete docked[id];
  const w = d.w;
  w.captionChanged.disconnect(d.onCaption);
  w.noBorder = d.saved.noBorder;
  w.skipTaskbar = d.saved.skipTaskbar;
  w.skipSwitcher = d.saved.skipSwitcher;
  w.skipPager = d.saved.skipPager;
  w.minimized = false;
  w.frameGeometry = d.saved.geo;
}

function run(c) {
  const d = docked[c.id];
  switch (c.cmd) {
    case 'list':
      emit({ ev: 'windows', list: windows().filter((w) => dockable(w) && !docked[idOf(w)]).map((w) => ({ id: idOf(w), title: w.caption })) });
      break;
    case 'embed': embed(c.id); break;
    case 'place':
      if (!d) break;
      d.rel = { x: c.x, y: c.y, width: c.w, height: c.h };
      if (!d.shown) {
        d.shown = true;
        apply(d);
        workspace.raiseWindow(d.w);
      } else apply(d);
      break;
    case 'hide':
      if (d && d.shown) { d.shown = false; d.w.minimized = true; }
      break;
    case 'focus': if (d) workspace.activeWindow = d.w; break;
    case 'close': if (d) d.w.closeWindow(); break;
    case 'release': release(c.id); emit({ ev: 'released', id: c.id }); break;
    case 'release-all':
      for (const id of Object.keys(docked)) release(id);
      emit({ ev: 'released-all' });
      break;
    case 'launch': {
      const w = windows().find((x) => x.pid === c.pid && dockable(x) && !docked[idOf(x)]);
      if (w) emit({ ev: 'launch', id: c.id, win: idOf(w) });
      else launches[c.id] = { pid: c.pid, cls: c.cls };
      break;
    }
    case 'launch-cancel': delete launches[c.id]; break;
    case 'cursor': {
      const p = workspace.cursorPos;
      const g = self ? self.frameGeometry : null;
      const outside = !g || p.x < g.x || p.y < g.y || p.x >= g.x + g.width || p.y >= g.y + g.height;
      emit({ ev: 'cursor', id: c.id, outside });
      break;
    }
    case 'stop': stopped = true; break;
  }
}

function poll() {
  if (stopped) return;
  callDBus(SERVICE, '/', IFACE, 'Poll', (text) => {
    let cmds = [];
    try { cmds = JSON.parse(text); } catch (e) { /* not a list: nothing to do */ }
    for (const c of cmds) {
      try { run(c); } catch (e) { emit({ ev: 'error', id: c.id, what: String(e) }); }
    }
    poll();
  });
}

workspace.windowAdded.connect((w) => {
  if (!self && isSelf(w)) { adopt(w); return; }
  if (!dockable(w)) return;
  for (const id of Object.keys(launches)) {
    const l = launches[id];
    if (w.pid === l.pid || (l.cls && String(w.resourceClass).toLowerCase() === l.cls)) {
      delete launches[id];
      emit({ ev: 'launch', id: +id, win: idOf(w) });
      return;
    }
  }
});

workspace.windowRemoved.connect((w) => {
  if (w === self) {
    // VibeCMD is gone (closed or crashed): nothing may stay hidden and without
    // a title bar.
    for (const id of Object.keys(docked)) release(id);
    self = null;
    stopped = true;
    return;
  }
  const id = idOf(w);
  if (docked[id]) {
    delete docked[id];
    emit({ ev: 'gone', id });
  }
});

workspace.windowActivated.connect((w) => {
  if (!w) return;
  if (w === self) raiseDocked();
  else if (docked[idOf(w)]) emit({ ev: 'focus', id: idOf(w) });
});

const found = windows().find(isSelf);
if (found) adopt(found);
emit({ ev: 'ready' });
poll();
