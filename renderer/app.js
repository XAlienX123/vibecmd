'use strict';

/*
 * Layout is a tree:
 *   { type: 'leaf', id }                                  -> one pane
 *   { type: 'split', dir: 'row'|'col', children, sizes }  -> panes side by side / stacked
 * Pane DOM elements (with their live xterm inside) are kept in `sessions` and
 * just re-parented on every render, so moving a pane never restarts its process.
 */

const IS_WIN = deck.platform === 'win32';
// The "cmd" kind is cmd.exe on Windows and the user's own shell on Linux.
const SHELL_LABEL = IS_WIN ? 'CMD' : 'Terminal';

const KIND_LABEL = {
  claude: 'Claude',
  'claude-continue': 'Claude',
  cmd: SHELL_LABEL,
  powershell: 'PowerShell',
  editor: 'Editor',
  browser: 'Browser',
};

const TERM_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", "DejaVu Sans Mono", "Noto Sans Mono", monospace';

let themeName = localStorage.getItem('vibecmd.theme') in THEMES ? localStorage.getItem('vibecmd.theme') : DEFAULT_THEME;

const sessions = new Map();
const counters = {};
// Every tab has its own layout. `tree`, `parked`, `focusedId` and `zoomedId`
// always hold the active tab's state; switching tabs stashes them into the tab.
let tabs = [];
let activeTab = null;
let nextTabId = 1;
let tree = null;
let parked = [];
let focusedId = null;
let zoomedId = null;
let defaultCwd = null;
let nextPaneId = 1;
let dragPayload = null;

const $layout = document.getElementById('layout');
const $trayItems = document.getElementById('tray-items');
const $tray = document.getElementById('tray');
const $cwd = document.getElementById('cwd');
const $tabs = document.getElementById('tabs');

// ---------------------------------------------------------------- tree ops

const leaf = (id) => ({ type: 'leaf', id });
const split = (dir, children, sizes) =>
  ({ type: 'split', dir, children, sizes: sizes || children.map(() => 1) });

function findLeaf(node, id, parent = null, index = -1) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === id ? { node, parent, index } : null;
  for (let i = 0; i < node.children.length; i++) {
    const hit = findLeaf(node.children[i], id, node, i);
    if (hit) return hit;
  }
  return null;
}

function leafIds(node, out = []) {
  if (!node) return out;
  if (node.type === 'leaf') out.push(node.id);
  else node.children.forEach((c) => leafIds(c, out));
  return out;
}

// Collapse single-child splits and merge nested splits that go the same way.
function normalize(node) {
  if (!node || node.type === 'leaf') return node;
  const children = [];
  const sizes = [];
  node.children.forEach((child, i) => {
    const c = normalize(child);
    if (!c) return;
    if (c.type === 'split' && c.dir === node.dir) {
      const total = c.sizes.reduce((a, b) => a + b, 0);
      c.children.forEach((cc, j) => {
        children.push(cc);
        sizes.push((node.sizes[i] * c.sizes[j]) / total);
      });
    } else {
      children.push(c);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  node.children = children;
  node.sizes = sizes;
  return node;
}

function removeFromTree(id) {
  const hit = findLeaf(tree, id);
  if (!hit) return false;
  if (!hit.parent) {
    tree = null;
  } else {
    hit.parent.children.splice(hit.index, 1);
    hit.parent.sizes.splice(hit.index, 1);
    tree = normalize(tree);
  }
  return true;
}

// Put pane `id` on `side` of pane `targetId` (or of the whole layout if targetId is null).
function insertAt(id, targetId, side) {
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  const fresh = leaf(id);

  if (!tree) { tree = fresh; return; }

  // The middle of a pane: the new pane takes its place and the old one closes
  // (or goes to the tray if it asks to stay, e.g. an unsaved file).
  if (side === 'center') {
    const old = findLeaf(tree, targetId);
    if (old) {
      const oldId = old.node.id;
      old.node.id = id;
      closeSession(oldId).then(() => {
        if (!sessions.has(oldId)) return;
        parked.push(oldId);
        render();
      });
      return;
    }
    insertAt(id, targetId, 'right');
    return;
  }

  if (targetId == null) {
    tree = normalize(split(dir, before ? [fresh, tree] : [tree, fresh]));
    return;
  }

  const hit = findLeaf(tree, targetId);
  if (!hit) { tree = normalize(split('row', [tree, fresh])); return; }
  const { node, parent, index } = hit;

  if (parent && parent.dir === dir) {
    const half = parent.sizes[index] / 2;
    parent.sizes[index] = half;
    const at = before ? index : index + 1;
    parent.children.splice(at, 0, fresh);
    parent.sizes.splice(at, 0, half);
    return;
  }

  const wrapper = split(dir, before ? [fresh, node] : [node, fresh]);
  if (parent) parent.children[index] = wrapper;
  else tree = wrapper;
}

function swap(a, b) {
  const ha = findLeaf(tree, a);
  const hb = findLeaf(tree, b);
  if (ha && hb) { ha.node.id = b; hb.node.id = a; }
}

// Move an existing pane (from the layout or the tray) next to / onto another pane.
function movePane(id, targetId, side) {
  if (id === targetId) return;
  if (side === 'center') {
    if (findLeaf(tree, id)) {
      swap(id, targetId);
    } else {
      // From the tray onto a pane: they trade places.
      const hit = findLeaf(tree, targetId);
      if (!hit) return;
      hit.node.id = id;
      parked = parked.filter((p) => p !== id);
      parked.push(targetId);
    }
  } else {
    if (!removeFromTree(id)) parked = parked.filter((p) => p !== id);
    insertAt(id, targetId, side);
  }
  focusedId = id;
  render();
}

// Where a new pane goes when you click a button instead of dragging it.
function autoPlace(id, nearId) {
  const target = autoTarget(nearId);
  if (target == null) { insertAt(id, null, 'right'); return; }
  insertAt(id, target, autoSide(target));
}

const autoTarget = (nearId) => (nearId != null && findLeaf(tree, nearId) ? nearId : leafIds(tree).at(-1));

function autoSide(target) {
  const r = sessions.get(target).el.getBoundingClientRect();
  return r.width >= r.height * 1.4 ? 'right' : 'bottom';
}

// ---------------------------------------------------------------- sessions

function nextTitle(kind) {
  const label = KIND_LABEL[kind] || kind;
  counters[label] = (counters[label] || 0) + 1;
  return `${label} ${counters[label]}`;
}

function buildPaneEl(s) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.kind = s.kind;
  el.innerHTML = `
    <div class="pane-head" draggable="true">
      <span class="dot"></span>
      <span class="title"></span>
      <span class="status"></span>
      <span class="path"></span>
      <span class="btns">
        <button data-act="claude" title="New Claude next to this one, same folder">+C</button>
        <button data-act="cmd" title="New CMD next to this one, same folder">&gt;_</button>
        <button data-act="park" title="Park (keeps running, shows in bottom tray)">▁</button>
        <button data-act="zoom" title="Maximize / restore (Ctrl+Shift+Enter)">□</button>
        <button data-act="undock" class="undock" title="Undock: give the window back as a normal window">⇱</button>
        <button data-act="close" class="close" title="Close (Ctrl+Shift+W)">✕</button>
      </span>
    </div>
    <div class="term"></div>
    <div class="drop-overlay"><div class="drop-hint"></div></div>`;

  const head = el.querySelector('.pane-head');
  const title = el.querySelector('.title');
  title.textContent = s.title;
  el.querySelector('.path').textContent = s.cwd;
  el.querySelector('.path').title = s.cwd;

  head.addEventListener('dragstart', (e) => startDrag(e, { type: 'pane', id: s.id }));
  head.addEventListener('dragend', async () => {
    endDrag();
    // Dragging a pane out of VibeCMD pops it out as a normal window.
    if (await deck.cursorOutside()) popOut(s);
  });
  // Middle-click on the title bar closes the pane.
  head.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  head.addEventListener('auxclick', (e) => {
    if (e.button !== 1 || e.target.closest('.btns')) return;
    e.preventDefault();
    closeSession(s.id);
  });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openHeaderMenu(s, e.clientX, e.clientY);
  });

  title.addEventListener('dblclick', () => {
    title.contentEditable = 'true';
    head.draggable = false;
    title.focus();
    document.getSelection().selectAllChildren(title);
  });
  const commit = () => {
    title.contentEditable = 'false';
    head.draggable = true;
    const name = title.textContent.trim();
    // A docked pane follows its window's title until you name it yourself.
    if (name && name !== s.title) s.renamed = true;
    s.title = name || s.title;
    title.textContent = s.title;
    save();
  };
  title.addEventListener('blur', commit);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); title.blur(); }
  });

  head.querySelector('.btns').addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    e.stopPropagation();
    if (act === 'claude' || act === 'cmd') newSession(act, { cwd: s.cwd, near: s.id });
    else if (act === 'park') park(s.id);
    else if (act === 'zoom') toggleZoom(s.id);
    else if (act === 'close') closeSession(s.id);
    else if (act === 'undock') undock(s.id);
  });

  el.dataset.id = s.id;
  // Only the left button focuses; right-click opens the new-pane menu/wheel instead.
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    activeTab.fresh = false;
    // A docked app gets the keyboard from a click on its title bar too.
    setFocus(s.id, s.kind === 'app');
  });
  attachDropZone(el.querySelector('.drop-overlay'), s.id);
  return el;
}

// Keeps each Claude pane pointed at the chat it's on now (also after /clear or
// /resume), so a restart reopens that chat.
const sessionForPty = (ptyId) => [...sessions.values()].find((x) => x.ptyId === ptyId);

deck.onBusy((ptyId, busy) => {
  const s = sessionForPty(ptyId);
  if (!s) return;
  s.busy = busy;
  s.el.classList.toggle('busy', busy);
});

deck.onClaudeSession((ptyId, sessionId) => {
  const s = sessionForPty(ptyId);
  if (!s || s.claudeId === sessionId) return;
  s.claudeId = sessionId;
  if (s.kind === 'claude-continue') s.kind = 'claude';
  save();
});

function setColor(s, color) {
  s.color = color || null;
  s.el.classList.toggle('colored', !!color);
  if (color) s.el.style.setProperty('--pc', color);
  else s.el.style.removeProperty('--pc');
}

function startRename(s) {
  s.el.querySelector('.title').dispatchEvent(new Event('dblclick'));
}

function createSession({ kind, cwd, title, claudeId, fontSize, hwnd, color, renamed, app, uid, link, linkEditor, run, files, file, wrap, url }) {
  // Editor panes used to dock an outside editor (Notepad++, Kate...) on its
  // file; they reopen as built-in editors on that file.
  if (kind === 'app' && app?.file) {
    kind = 'editor';
    files = [app.file];
    app = null;
  }
  const s = {
    id: nextPaneId++,
    // Stays the same across restarts, so links between panes survive them.
    uid: uid || crypto.randomUUID(),
    // Claude panes: the editor pane (uid) showing the files Claude edits, and
    // whether to open one if there's none (see "linked editors").
    link: link || null,
    linkEditor: !!linkEditor,
    // Editor panes: the files open in it and the one showing (see editor.js).
    files: files || (file ? [file] : []),
    file: file || null,
    wrap: !!wrap,
    // Browser panes: the page's address (see browser.js).
    url: url || null,
    // Shell panes: a command typed in at the first prompt, every time it starts.
    run: run || null,
    kind,
    cwd: cwd || defaultCwd,
    title: title || nextTitle(kind),
    // Lets this pane reopen its own chat after a restart (see commandFor in main.js).
    claudeId: kind === 'claude' ? claudeId || crypto.randomUUID() : null,
    ptyId: null,
    // Set for a docked outside window (see "docked CMD windows" below).
    hwnd: hwnd || null,
    // A docked app (kind 'app'): { exe, args } to start it again next time.
    app: app || null,
    exited: false,
    opened: false,
    // Named by hand, so it no longer names itself (see autoTitle).
    renamed: !!renamed,
    // Enter inside Claude isn't a shell command (see autoTitle).
    inClaude: kind.startsWith('claude'),
  };
  s.el = buildPaneEl(s);
  s.termEl = s.el.querySelector('.term');
  setColor(s, color);
  if (kind === 'app') {
    s.el.classList.add('docked', 'app');
    s.el.querySelector('.path').textContent = '';
    s.el.querySelector('[data-act="close"]').title = 'Close this app (it asks to save, as usual)';
    s.termEl.addEventListener('click', () => { if (!s.hwnd && !s.launching) launchApp(s); });
  } else if (kind === 'editor') {
    setupEditorPane(s);
  } else if (kind === 'browser') {
    setupBrowserPane(s);
  }

  // Editor and browser panes never open theirs, but keep its font size.
  s.term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: fontSize || 13,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    // Panes without focus (and every pane while another window has it) still
    // show where typing goes, instead of xterm's barely visible outline.
    cursorInactiveStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: true,
    // ConPTY repaints the screen itself after a resize; without this xterm also
    // reflows it, and full-screen apps like Claude end up garbled.
    windowsPty: IS_WIN ? { backend: 'conpty', buildNumber: deck.windowsBuild } : undefined,
    theme: THEMES[themeName].term,
    // Text on coloured backgrounds (Claude's diffs, for one) is brightened or
    // darkened as needed to stay readable, whatever the theme.
    minimumContrastRatio: 3,
  });
  s.fit = new FitAddon.FitAddon();
  s.term.loadAddon(s.fit);
  s.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => deck.openExternal(uri)));

  s.term.attachCustomKeyEventHandler((e) => handleTermKey(s, e));
  s.term.onData((data) => {
    if (s.exited) {
      if (data === '\r') respawn(s);
      return;
    }
    if (s.psel) data = typeOverSelection(s, data);
    // Enter at a shell prompt: the pane is now running that command.
    if (data.includes('\r') && s.atPrompt && !s.inClaude) {
      const command = typedCommand(s);
      if (command) {
        s.atPrompt = false;
        autoTitle(s, command);
      }
    }
    if (data) sendKeys(s, data);
  });
  s.term.onCursorMove(() => { if (s.psel) showPromptSel(s); });
  // A click starts over: in the output it also places the point Shift+arrows
  // select from (see "keyboard selection" below).
  s.termEl.addEventListener('mousedown', (e) => {
    s.psel = null;
    s.out = null;
    if (e.button !== 0) return;
    // xterm settles its own selection on mouseup, wherever the mouse is by then.
    window.addEventListener('mouseup', (up) => setTimeout(() => placeOutputPoint(s, up)), { once: true });
  });
  s.term.onTitleChange((t) => {
    s.el.querySelector('.status').textContent = t;
    const topic = claudeTopic(t);
    if (topic === null) return;
    s.inClaude = true;
    if (topic) autoTitle(s, topic);
  });
  // cmd reports its folder at every prompt (PROMPT is set up in main.js).
  s.term.parser.registerOscHandler(9, (data) => {
    if (!data.startsWith('9;')) return false;
    const dir = data.slice(2).replace(/^"|"$/g, '');
    // Back at the prompt (also after leaving Claude): named after the folder.
    s.atPrompt = true;
    s.inClaude = false;
    if (dir && dir !== s.cwd) {
      s.cwd = dir;
      const p = s.el.querySelector('.path');
      p.textContent = p.title = dir;
      save();
    }
    // The pane's start command goes in at its first prompt.
    if (s.pendingRun) {
      const run = s.pendingRun;
      s.pendingRun = null;
      s.atPrompt = false;
      autoTitle(s, run);
      setTimeout(() => sendKeys(s, `${run}\r`));
    } else if (dir) {
      autoTitle(s, folderName(dir));
    }
    return true;
  });

  // Ctrl+scroll changes this pane's text size. A docked window keeps its
  // history in the console itself, so plain scrolling scrolls that.
  s.termEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && s.hwnd) {
      e.preventDefault();
      e.stopPropagation();
      deck.scrollWindow(s.hwnd, Math.sign(e.deltaY) * 3);
      return;
    }
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const size = s.term.options.fontSize + (e.deltaY < 0 ? 1 : -1);
    s.term.options.fontSize = Math.max(8, Math.min(32, size));
    s.editor?.updateOptions({ fontSize: s.term.options.fontSize });
    fitSession(s);
    save();
  }, { capture: true, passive: false });

  let fitTimer;
  // Fit once more after the font finishes loading, in case the first fit
  // measured a fallback font's character width.
  document.fonts.ready.then(() => fitSession(s));
  new ResizeObserver(() => {
    if (s.kind === 'app' || s.kind === 'browser') { syncApps(); return; }
    if (s.kind === 'editor') return; // the editor follows its size itself
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => fitSession(s), 30);
  }).observe(s.termEl);

  sessions.set(s.id, s);
  return s;
}

// ---------------------------------------------------------------- docked CMD windows
//
// A CMD window from outside, dragged onto VibeCMD. The window itself is hidden
// (native/winhelper.cs) and its console's screen is drawn in a normal pane, so
// whatever runs in it carries on untouched. It can't be saved across restarts.
// Closing the pane (or quitting) closes the window; ⇱ gives it back instead.
//
// Any other app window (an editor, say) is docked as itself: see "docked apps".

function createDockedSession(hwnd, { title: windowTitle, app, exe, args }) {
  if (app) {
    const s = createSession({ kind: 'app', hwnd, title: exe.split(/[\\/]/).pop(), app: { exe, args } });
    appTitle(s, windowTitle || '');
    return s;
  }
  const s = createSession({ kind: 'docked', hwnd, title: windowTitle || 'CMD' });
  s.el.classList.add('docked');
  s.el.querySelector('.path').textContent = '';
  s.el.querySelector('[data-act="close"]').title = 'Close this window and what runs in it';
  dockedBusy(s, windowTitle);
  // The console keeps its own history (scrolled with the wheel, see createSession).
  s.term.options.scrollback = 0;
  deck.onWindowData(hwnd, (d) => s.term.write(d));
  return s;
}

// `tab`: dropped on a tab (or 'new' for the + button), so it docks into that
// tab next to its last pane, and that tab opens.
async function dockWindow(hwnd, targetId, side, tab) {
  if ([...sessions.values()].some((s) => s.hwnd === hwnd)) return;
  const res = await deck.dockWindow(hwnd);
  if (!res) return;
  // Notepad and Notepad++ become a built-in editor pane on their files. The
  // window is asked to close, so it can offer to save; Cancel keeps it docked.
  const files = res.app ? plainEditorFiles(res) : [];
  if (files.length) {
    if (!await deck.closeApp(hwnd)) {
      deck.releaseWindow(hwnd);
      return;
    }
    if (tab === 'new') newTab();
    else if (tab && tab !== activeTab && tabs.includes(tab)) { stashTab(); loadTab(tab); }
    if (tab) { targetId = leafIds(tree).at(-1) ?? null; side = 'right'; }
    const e = createSession({ kind: 'editor', cwd: files[0].replace(/[\\/][^\\/]*$/, ''), files, file: files[0] });
    activeTab.fresh = false;
    if (side && (targetId == null || findLeaf(tree, targetId))) insertAt(e.id, targetId, side);
    else autoPlace(e.id, focusedId);
    focusedId = e.id;
    zoomedId = null;
    render();
    return;
  }
  if (tab === 'new') {
    newTab();
  } else if (tab && tab !== activeTab && tabs.includes(tab)) {
    stashTab();
    loadTab(tab);
  }
  if (tab) {
    targetId = leafIds(tree).at(-1) ?? null;
    side = 'right';
  }
  const s = createDockedSession(hwnd, res);
  if (side && (targetId == null || findLeaf(tree, targetId))) insertAt(s.id, targetId, side);
  else autoPlace(s.id, focusedId);
  focusedId = s.id;
  zoomedId = null;
  render();
}

// The files a docked Notepad / Notepad++ has open: its command line's paths,
// else the path Notepad++ puts at the start of its title.
function plainEditorFiles({ exe, args, title }) {
  if (!/^notepad(\+\+)?(\.exe)?$/i.test(exe.split(/[\\/]/).pop())) return [];
  const isPath = (p) => /^([a-z]:[\\/]|\\\\)/i.test(p);
  const files = [...(args || '').matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] || m[2]).filter(isPath);
  const fromTitle = /^[*●]?\s*(.+?) - Notepad\+\+/i.exec(title || '')?.[1];
  if (!files.length && fromTitle && isPath(fromTitle)) files.push(fromTitle);
  return files;
}

const dockedPane = (hwnd) => [...sessions.values()].find((s) => s.hwnd === hwnd);

// A docked window's title tells whether it's busy: Claude shows a spinner while
// working (✳ when idle), and cmd adds " - <command>" while one runs.
function dockedBusy(s, title = '') {
  const busy = '◐◑◒◓'.includes(title[0]) || (title[0] !== '✳' && /(cmd\.exe|Command Prompt) - /i.test(title));
  if (busy === !!s.busy) return;
  s.busy = busy;
  s.el.classList.toggle('busy', busy);
  deck.setWindowBusy(s.hwnd, busy);
}

function undock(id) {
  const s = sessions.get(id);
  if (!s?.hwnd) return;
  deck.releaseWindow(s.hwnd);
  appPlaced.delete(s.hwnd);
  s.hwnd = null;
  s.busy = false;
  closeSession(id);
}

// A normal pane becomes a real console window (see pane:popOut in main.js); a
// docked window is just handed back.
async function popOut(s) {
  if (!sessions.has(s.id)) return;
  if (s.hwnd) { undock(s.id); return; }
  // A page goes to the normal browser, and stays here too; a file stays here.
  if (s.kind === 'browser') { if (s.url) deck.openExternal(s.url); return; }
  if (s.kind === 'editor') return;
  if (s.busy && !s.exited &&
      !confirm(`${busyWhat(s)} in "${s.title}". Popping it out restarts it as a window (Claude resumes its chat). Continue?`)) return;
  if (!await deck.popOut({ ptyId: s.ptyId, kind: s.kind, cwd: s.cwd, claudeId: s.claudeId, title: s.title })) {
    alert('No terminal app found to pop out into (tried konsole, gnome-terminal, kitty, alacritty, wezterm, ghostty, foot, xfce4-terminal, xterm).');
    return;
  }
  closeSession(s.id, true);
}

deck.onDockedTitle((hwnd, title) => {
  const s = dockedPane(hwnd);
  if (s?.kind === 'app') appTitle(s, title);
  else if (s) { dockedBusy(s, title); autoTitle(s, title); }
});

// ---------------------------------------------------------------- docked apps
//
// An app window (Notepad, Notepad++, Kate...) dragged onto VibeCMD becomes a
// child of VibeCMD's window, frameless, laid over its pane (Windows only, see
// native/winhelper.cs). It's the real app, so everything in it works as usual.
// Being a native window it would cover menus and dialogs drawn here, so it's
// hidden while one of those overlaps it. Saved like any pane: next launch
// starts the app again with the same arguments (usually its file).

let appsQueued = false;
let quitting = false;

// Where each app window (and browser pane's page, keyed "b<id>") is now
// ("x y w h", or null when hidden), so only changes are sent.
const appPlaced = new Map();

function syncApps() {
  if (appsQueued) return;
  appsQueued = true;
  requestAnimationFrame(() => {
    appsQueued = false;
    const covers = [...document.querySelectorAll('.kind-menu, .wheel')].map((el) => el.getBoundingClientRect());
    const hideAll = document.body.classList.contains('dragging') || !$help.hidden || !!document.querySelector('.modal');
    for (const s of sessions.values()) {
      const key = s.kind === 'app' ? s.hwnd : s.kind === 'browser' && s.browserId != null ? `b${s.browserId}` : null;
      if (!key) continue;
      const r = (s.viewEl || s.termEl).getBoundingClientRect();
      const shown = s.el.isConnected && !hideAll && r.width > 0 && r.height > 0 &&
        (zoomedId == null || zoomedId === s.id) &&
        !covers.some((c) => c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top);
      const at = shown ? `${r.left} ${r.top} ${r.width} ${r.height}` : null;
      if (appPlaced.get(key) === at) continue;
      appPlaced.set(key, at);
      if (s.kind === 'browser') {
        if (at) deck.placeBrowser(s.browserId, r.left, r.top, r.width, r.height);
        else deck.hideBrowser(s.browserId);
      } else if (at) {
        deck.placeApp(s.hwnd, r.left, r.top, r.width, r.height);
      } else {
        deck.hideApp(s.hwnd);
      }
    }
  });
}

// Menus, the wheel, dialogs and drags come and go as elements on <body>.
new MutationObserver(syncApps).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', syncApps);

function appNote(s, text) {
  s.termEl.textContent = text;
}

// Starts a saved app again (or after it was closed) and docks its window.
async function launchApp(s) {
  const name = s.app?.exe?.split(/[\\/]/).pop() || s.title;
  s.launching = true;
  appNote(s, `Starting ${name}…`);
  const hwnd = await deck.launchApp(s.app || {});
  const res = hwnd && sessions.has(s.id) && !dockedPane(hwnd) ? await deck.dockWindow(hwnd) : null;
  s.launching = false;
  if (!sessions.has(s.id)) {
    if (res) deck.releaseWindow(hwnd);
    return;
  }
  if (!res) {
    appNote(s, IS_WIN ? `Couldn't start ${name}. Click to try again.` : `Couldn't start and dock ${name}. Click to try again (docking needs xdotool and xprop).`);
    return;
  }
  appNote(s, '');
  s.hwnd = hwnd;
  appTitle(s, res.title);
  syncApps();
}

// Closing an app pane asks the app to close, so it can offer to save; the pane
// only goes once the app has (Cancel in its save question keeps both).
async function closeApp(s) {
  if (!s.hwnd) return true;
  if (!await deck.closeApp(s.hwnd)) return false;
  appPlaced.delete(s.hwnd);
  s.hwnd = null;
  return true;
}

deck.onAppFocus((hwnd) => {
  const s = dockedPane(hwnd);
  if (s && focusedId !== s.id) setFocus(s.id);
});

// Apps put a marker in their title while a file has unsaved changes:
// "*name" (Notepad, Notepad++), "name *" (Kate), "● name" (VS Code),
// "name •" (Sublime Text).
const UNSAVED = /^[*●]\s*|\s[*•](?=\s|$)/u;

function appTitle(s, title) {
  const unsaved = UNSAVED.test(title);
  if (unsaved !== !!s.unsaved) {
    s.unsaved = unsaved;
    s.el.classList.toggle('unsaved', unsaved);
    s.el.querySelector('.status').textContent = unsaved ? 'unsaved' : '';
    renderTabs();
  }
  // Notepad++ titles start with the file's full path; the name is enough.
  autoTitle(s, title.replace(UNSAVED, ' ').replace(/\s+/g, ' ').trim().replace(/^[a-z]:\\(?:[^\\]*\\)*/i, ''));
}

// ---- opening files in an editor pane (see editor.js)

// A new editor pane with `file` open (a new, empty file for null).
// `keepFocus`: opened for another pane (a linked Claude), which keeps focus.
function openFileInPane(file, { targetId, side, keepFocus } = {}) {
  const s = createSession({ kind: 'editor', cwd: file ? file.replace(/[\\/][^\\/]*$/, '') : undefined, files: file ? [file] : [] });
  activeTab.fresh = false;
  if (side) insertAt(s.id, targetId ?? null, side);
  else autoPlace(s.id, focusedId);
  if (!keepFocus) focusedId = s.id;
  zoomedId = null;
  render();
  return s;
}

// "Open file…" from a pane's menu or wheel: the file dialog starts in that
// pane's folder, and the editor goes where the preview showed.
async function openFileFromMenu(ctx, preview) {
  const file = await deck.pickFile({ defaultPath: ctx?.s.cwd || defaultCwd, title: 'Open which file?', buttonLabel: 'Open in editor' });
  if (file) openFileInPane(file, { targetId: ctx?.s.id ?? null, side: preview?.side ?? 'right' });
}

// ---- linked editors
//
// A Claude pane can be linked to an editor pane: every file Claude edits or
// writes (reported by its PostToolUse hook, see main.js) opens there, or comes
// to the front if it's open already, with the lines Claude changed lit up. A
// link set up with "a new editor pane" opens that pane at Claude's first edit.

const sessionByUid = (uid) => [...sessions.values()].find((x) => x.uid === uid);
const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

// Runs `fn` with tab `t` loaded as the current one, without showing it.
function inTab(t, fn) {
  if (!t || t === activeTab) return fn();
  const cur = activeTab;
  stashTab();
  loadTab(t);
  try { return fn(); } finally { stashTab(); loadTab(cur); }
}

deck.onEdited((ptyId, file) => {
  const s = sessionForPty(ptyId);
  if (!s || (!s.link && !s.linkEditor)) return;
  const target = s.link && sessionByUid(s.link);
  if (target?.kind === 'editor') { showInEditor(target, file); return; }
  if (!s.linkEditor) return;
  // First edit: the editor pane opens to the right of Claude's.
  const e = createSession({ kind: 'editor', cwd: file.replace(/[\\/][^\\/]*$/, ''), files: [file] });
  inTab(tabOf(s.id), () => (findLeaf(tree, s.id) ? insertAt(e.id, s.id, 'right') : autoPlace(e.id, null)));
  s.link = e.uid;
  s.linkEditor = false;
  render();
});

// A pane not shown yet (another tab) opens the file once it is.
async function showInEditor(s, file) {
  if (!s.editor) {
    if (!s.files.some((f) => samePath(f, file))) s.files.push(file);
    s.file = file;
    save();
    return;
  }
  const d = await openInPane(s, file);
  if (d) reloadDoc(d);
}

function linkItems(s) {
  if (!s.kind.startsWith('claude')) return [];
  const mark = (on, label) => (on ? `✓ ${label}` : label);
  const here = tabSessionIds(activeTab).map((id) => sessions.get(id)).filter((x) => x.kind === 'editor');
  return [
    { sep: true },
    ...here.map((a) => ({
      label: mark(s.link === a.uid, `Show Claude's edits in "${a.title}"`),
      run: () => { s.link = a.uid; s.linkEditor = false; save(); },
    })),
    {
      label: mark(!s.link && s.linkEditor, "Show Claude's edits in a new editor pane"),
      run: () => { s.link = null; s.linkEditor = true; save(); },
    },
    ...(s.link || s.linkEditor ? [{ label: "Stop showing Claude's edits", run: () => { s.link = null; s.linkEditor = false; save(); } }] : []),
  ];
}

// Quitting VibeCMD: each app is shown in turn while it's asked to close.
deck.onAppReveal((hwnd) => {
  const s = dockedPane(hwnd);
  if (!s) return;
  const t = tabs.find((x) => tabSessionIds(x).includes(s.id));
  if (t) switchTab(t);
  if (parked.includes(s.id)) unpark(s.id);
  if (zoomedId != null && zoomedId !== s.id) toggleZoom(zoomedId);
  syncApps();
});

// While quitting, apps that close keep their panes (they reopen next launch).
// If one of them cancelled, VibeCMD stays open: start those again.
deck.onQuitting((on) => {
  quitting = on;
  if (on) return;
  for (const s of sessions.values()) {
    if (s.kind === 'app' && !s.hwnd && s.opened && !s.launching) launchApp(s);
  }
});

// ---------------------------------------------------------------- automatic pane names

// Panes name themselves after what they're doing until you rename them:
// Claude panes take the topic Claude puts in its window title, shell panes the
// command that's running (and their folder's name while at the prompt).
function autoTitle(s, title) {
  title = (title || '').trim();
  if (!sessions.has(s.id) || s.renamed || !title || title === s.title) return;
  s.title = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  s.el.querySelector('.title').textContent = s.title;
  if (parked.includes(s.id)) renderTray();
  save();
}

// Claude's title is "<status glyph> <topic>", "Claude Code" until it has one.
const CLAUDE_GLYPH = /^[✳◐◑◒◓⠀-⣿✻✽✶·*]\s*/u;

function claudeTopic(title) {
  if (!CLAUDE_GLYPH.test(title)) return null;
  const topic = title.replace(CLAUDE_GLYPH, '').trim();
  return topic && topic !== 'Claude Code' ? topic : '';
}

// The command line Enter was just pressed on: the cursor's (possibly wrapped)
// line with the prompt cut off. Prompts end in one of these characters.
const PROMPT_END = /^.*?[>$#%❯➜λ»›]\s*/u;

function typedCommand(s) {
  const buf = s.term.buffer.active;
  let row = buf.baseY + buf.cursorY;
  let text = buf.getLine(row)?.translateToString(true) || '';
  while (row > 0 && buf.getLine(row)?.isWrapped) text = buf.getLine(--row).translateToString(true) + text;
  return text.replace(PROMPT_END, '').trim();
}

const folderName = (dir) => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;

// The window closed by itself (e.g. you typed `exit` in it).
deck.onDockedGone((hwnd) => {
  const s = dockedPane(hwnd);
  if (!s) return;
  s.hwnd = null;
  s.busy = false;
  appPlaced.delete(hwnd);
  // Quitting: the pane stays.
  if (s.kind === 'app' && quitting) return;
  closeSession(s.id);
});

// A CMD window being dragged over VibeCMD: show where it would dock.
deck.onWindowDrag((phase, hwnd, x, y, over) => {
  if (dragPayload && dragPayload.type !== 'window') return;
  if (!over) {
    if (dragPayload) endDrag();
    return;
  }
  // Drop zones have to be showing for elementFromPoint to find them.
  if (!dragPayload) {
    dragPayload = { type: 'window', hwnd };
    document.body.classList.add('dragging');
  }
  const target = dropTargetAt(x, y);
  if (phase === 'end') {
    endDrag();
    dockWindow(hwnd, target.paneId, target.side, target.tab);
    return;
  }
  document.querySelectorAll('.drop-hint').forEach((h) => { h.style.display = 'none'; });
  document.querySelectorAll('.empty.drop-target, .tab.drop-target, #new-tab.drop-target')
    .forEach((el) => el.classList.remove('drop-target'));
  if (target?.tabEl) target.tabEl.classList.add('drop-target');
  else if (target?.overlay) showHint(target.overlay, target.side);
  else if (target?.empty) target.empty.classList.add('drop-target');
});

function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const tabEl = el?.closest('.tab, #new-tab');
  if (tabEl) {
    const tab = tabEl.id === 'new-tab' ? 'new' : tabs.find((t) => t.id === +tabEl.dataset.tabId);
    if (tab) return { tabEl, tab };
  }
  const overlay = el?.closest('.drop-overlay');
  if (overlay) {
    // A window dropped in the middle of a pane replaces it (see insertAt).
    return { overlay, paneId: +overlay.dataset.paneId, side: zoneFor({ clientX: x, clientY: y }, overlay, true) };
  }
  const empty = el?.closest('.empty') || document.querySelector('#layout > .empty');
  if (empty) return { empty, paneId: null, side: 'right' };
  // Somewhere else on the window (toolbar, gutter...): it goes next to the
  // focused pane, so preview it there.
  const near = autoTarget(focusedId);
  if (near == null) return { paneId: null, side: null };
  return { overlay: sessions.get(near).el.querySelector('.drop-overlay'), paneId: near, side: autoSide(near) };
}

// The terminal can only be opened once its element is actually on screen.
async function ensureOpened(s) {
  if (s.opened || !s.el.isConnected) return;
  s.opened = true;
  // An app pane shows the app's own window, no terminal; a reopened one (no
  // window yet) starts the app the first time its tab is shown.
  if (s.kind === 'app') {
    if (s.hwnd) syncApps();
    else launchApp(s);
    return;
  }
  if (s.kind === 'editor') { openEditorPane(s); return; }
  if (s.kind === 'browser') { openBrowserPane(s); return; }
  s.term.open(s.termEl);
  useWebgl(s);
  fitSession(s);
  await spawn(s);
}

// The WebGL renderer paints every cell's background edge to edge and draws
// block characters (█ ▌ ░, Claude's usage bars) itself; the default renderer
// leaves gaps between rows and uses the font's glyphs, which barely differ.
// Chromium only allows so many WebGL contexts, so a pane that loses its
// context falls back to the default renderer.
function useWebgl(s) {
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    s.term.loadAddon(gl);
  } catch { /* no WebGL: the default renderer still works */ }
}

// Claude Code (and most truecolor programs) pick their background colours for
// a black terminal: on any other background its diff lines and highlights come
// out muddy or barely visible. They're re-based onto the theme's background
// (black -> theme background, as a "screen" blend; the reverse for light
// themes) and strengthened a little, so they sit right on every theme.
function adaptColors(data) {
  if (!data.includes('48;2;')) return data;
  return data.replace(/\x1b\[([\d;]*)m/g, (seq, params) => {
    const p = params.split(';');
    let changed = false;
    for (let i = 0; i + 4 < p.length; i++) {
      if (p[i] === '48' && p[i + 1] === '2') {
        const [r, g, b] = adaptBg(+p[i + 2], +p[i + 3], +p[i + 4]);
        p.splice(i + 2, 3, r, g, b);
        changed = true;
        i += 4;
      } else if ((p[i] === '38' || p[i] === '58') && p[i + 1] === '2') {
        i += 4;
      } else if ((p[i] === '38' || p[i] === '48' || p[i] === '58') && p[i + 1] === '5') {
        i += 2;
      }
    }
    return changed ? `\x1b[${p.join(';')}m` : seq;
  });
}

let themeBg = [0, 0, 0];
let themeIsLight = false;

function adaptBg(r, g, b) {
  return [r, g, b].map((c, i) => {
    const base = themeBg[i];
    if (themeIsLight) {
      const v = 255 - Math.min(255, (255 - c) * 1.15);
      return Math.round((base * v) / 255);
    }
    const v = Math.min(255, c * 1.2);
    return Math.round(255 - ((255 - base) * (255 - v)) / 255);
  });
}

function setThemeBg(hex) {
  themeBg = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  themeIsLight = (0.299 * themeBg[0] + 0.587 * themeBg[1] + 0.114 * themeBg[2]) > 128;
}

async function spawn(s) {
  if (s.hwnd) return; // a docked window is already running; its screen streams in
  s.exited = false;
  s.el.classList.remove('exited');
  s.ptyId = await deck.createPty({
    kind: s.kind,
    cwd: s.cwd,
    cols: s.term.cols,
    rows: s.term.rows,
    sessionId: s.claudeId,
    restored: s.restored,
  });
  s.restored = false;
  if (s.run && !s.kind.startsWith('claude')) s.pendingRun = s.run;
  // The pane may have been resized while the process was starting (e.g. the
  // window maximizing at launch); that resize had no process to go to yet.
  deck.resize(s.ptyId, s.term.cols, s.term.rows);
  deck.onData(s.ptyId, (d) => s.term.write(adaptColors(d)));
  deck.onExit(s.ptyId, (code) => {
    s.exited = true;
    s.ptyId = null;
    s.el.classList.add('exited');
    s.el.querySelector('.status').textContent = `exited (${code})`;
    s.term.write('\r\n\x1b[90m[process exited, press Enter to restart]\x1b[0m\r\n');
  });
}

function respawn(s) {
  // From now on a "continue" pane tracks its own chat like any other Claude pane.
  if (s.kind === 'claude-continue') {
    s.kind = 'claude';
    s.claudeId = crypto.randomUUID();
  }
  s.term.reset();
  s.el.querySelector('.status').textContent = '';
  spawn(s);
}

function fitSession(s) {
  if (s.kind === 'app' || s.kind === 'browser') { syncApps(); return; }
  if (s.kind === 'editor') return;
  if (!s.opened || !s.el.isConnected || s.termEl.clientWidth === 0) return;
  try { s.fit.fit(); } catch { return; }
  if (s.ptyId != null) deck.resize(s.ptyId, s.term.cols, s.term.rows);
  else if (s.hwnd) deck.resizeWindow(s.hwnd, s.term.cols, s.term.rows);
}

function rememberCwd(dir) {
  defaultCwd = dir;
  localStorage.setItem('deck.cwd', dir);
  showCwd();
  save();
}

// Claude sessions always ask where to open, starting from the last folder picked.
// `extra`: more for createSession (a browser pane's url, say).
async function newSession(kind, { cwd, near, targetId, side, pick = true, extra } = {}) {
  if (kind === 'editor') { openFileInPane(null, { targetId: targetId ?? null, side }); return; }
  if (kind.startsWith('claude') && pick) {
    const dir = await deck.pickFolder({
      defaultPath: cwd || defaultCwd,
      title: 'Open Claude in which folder?',
      buttonLabel: 'Open Claude here',
    });
    if (!dir) return;
    cwd = dir;
    rememberCwd(dir);
  }
  const s = createSession({ kind, cwd, ...extra });
  activeTab.fresh = false;
  if (side) insertAt(s.id, targetId ?? null, side);
  else autoPlace(s.id, near ?? focusedId);
  focusedId = s.id;
  if (zoomedId != null) zoomedId = null;
  render();
}

// What a busy pane is doing, for the "close anyway?" questions.
const busyWhat = (s) => (s.kind.startsWith('claude') ? 'Claude is still working' : 'Something is still running');

async function closeSession(id, force = false) {
  const s = sessions.get(id);
  if (!s) return;
  // Idle panes reopen as they were anyway, so only ask when something's running.
  if (!force && s.busy && !s.exited &&
      !confirm(`${busyWhat(s)} in "${s.title}". Close it and stop that?`)) return;
  if (s.kind === 'app' && !await closeApp(s)) return;
  if (s.kind === 'editor' && !await closeEditorPane(s)) return;
  if (!sessions.has(id)) return;
  // The pane must leave the layout even if cleaning up after it throws,
  // or the others never take its space.
  try {
    if (s.ptyId != null) deck.kill(s.ptyId);
    if (s.hwnd) deck.closeWindow(s.hwnd);
    appPlaced.delete(s.hwnd);
    if (s.kind === 'browser') closeBrowserPane(s);
    s.term.dispose();
  } catch (err) {
    console.error('closing pane', err);
  }
  sessions.delete(id);
  removeFromTree(id);
  parked = parked.filter((p) => p !== id);
  if (zoomedId === id) zoomedId = null;
  if (focusedId === id) focusedId = leafIds(tree).at(-1) ?? null;
  render();
}

function park(id) {
  if (!removeFromTree(id)) return;
  parked.push(id);
  if (zoomedId === id) zoomedId = null;
  if (focusedId === id) focusedId = leafIds(tree).at(-1) ?? null;
  render();
}

function unpark(id) {
  parked = parked.filter((p) => p !== id);
  autoPlace(id, focusedId);
  focusedId = id;
  render();
}

function toggleZoom(id) {
  zoomedId = zoomedId === id ? null : id;
  render();
}

function setFocus(id, focusTerm = false) {
  focusedId = id;
  for (const s of sessions.values()) s.el.classList.toggle('focused', s.id === id);
  if (focusTerm) focusPane(sessions.get(id));
}

// Gives the keyboard to a pane: its terminal, editor, page or app window.
function focusPane(s) {
  if (!s) return;
  if (s.kind === 'app') { if (s.hwnd) deck.focusApp(s.hwnd); }
  else if (s.kind === 'editor') s.editor?.focus();
  else if (s.kind === 'browser') { if (s.browserId != null) deck.browserDo(s.browserId, 'focus'); }
  else s.term.focus();
}

// ---------------------------------------------------------------- tabs

function makeTab(name) {
  const id = nextTabId++;
  return { id, name: name || `Tab ${id}`, tree: null, parked: [], focusedId: null, zoomedId: null };
}

function stashTab() {
  if (activeTab) Object.assign(activeTab, { tree, parked, focusedId, zoomedId });
}

function loadTab(t) {
  activeTab = t;
  // Alt+K starts from the first pane after arriving on a tab (see cyclePane).
  t.fresh = true;
  ({ tree, parked, focusedId, zoomedId } = t);
}

function tabSessionIds(t) {
  if (t === activeTab) stashTab();
  return [...leafIds(t.tree), ...t.parked];
}

function switchTab(t) {
  if (!t || t === activeTab) return;
  stashTab();
  loadTab(t);
  render();
}

function newTab() {
  stashTab();
  const t = makeTab();
  tabs.push(t);
  loadTab(t);
  render();
}

async function closeTab(t) {
  let ids = tabSessionIds(t);
  const busy = ids.filter((id) => sessions.get(id).busy && !sessions.get(id).exited).length;
  if (busy && !confirm(`${busy} pane(s) in "${t.name}" are still working (Claude mid-task or a command running). Close the tab and stop that?`)) return;
  // Docked apps first, shown one at a time so their save questions make
  // sense. One that stays open (Cancel) keeps the tab.
  for (const id of ids) {
    const s = sessions.get(id);
    if (s?.kind !== 'app' || !s.hwnd) continue;
    switchTab(t);
    if (parked.includes(id)) unpark(id);
    if (!await closeApp(s)) return;
  }
  // Same for editors with unsaved files.
  for (const id of ids) {
    const s = sessions.get(id);
    if (s?.kind !== 'editor' || !s.docs.some(isDirty)) continue;
    switchTab(t);
    if (parked.includes(id)) unpark(id);
    if (!await closeEditorPane(s)) return;
  }
  if (!tabs.includes(t)) return;
  ids = tabSessionIds(t);
  for (const id of ids) {
    const s = sessions.get(id);
    if (s.ptyId != null) deck.kill(s.ptyId);
    if (s.hwnd) deck.closeWindow(s.hwnd);
    if (s.kind === 'editor') closeEditorPane(s);
    if (s.kind === 'browser') closeBrowserPane(s);
    s.term.dispose();
    sessions.delete(id);
  }
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(makeTab());
  if (t === activeTab) {
    activeTab = null;
    loadTab(tabs[Math.min(i, tabs.length - 1)]);
  }
  render();
}

// Steps through the panes of this tab in layout order, from the focused one; on
// a tab just switched to, the first press lands on the first (or, going back,
// the last) pane. Ctrl+K isn't used: Claude Code uses it to delete to end of line.
function cyclePane(step) {
  const ids = leafIds(tree);
  if (!ids.length) return;
  const at = ids.indexOf(focusedId);
  let next;
  if (activeTab.fresh || at < 0) next = step > 0 ? 0 : ids.length - 1;
  else next = (at + step + ids.length) % ids.length;
  activeTab.fresh = false;
  if (zoomedId != null) { zoomedId = ids[next]; render(); }
  setFocus(ids[next], true);
}

function cycleTab(step) {
  const i = tabs.indexOf(activeTab);
  switchTab(tabs[(i + step + tabs.length) % tabs.length]);
}

// Drop a pane onto another tab: it moves there and that tab opens.
function movePaneToTab(id, t) {
  if (t === activeTab) return;
  if (!removeFromTree(id)) parked = parked.filter((p) => p !== id);
  if (zoomedId === id) zoomedId = null;
  if (focusedId === id) focusedId = leafIds(tree).at(-1) ?? null;
  stashTab();
  loadTab(t);
  insertAt(id, leafIds(tree).at(-1) ?? null, 'right');
  focusedId = id;
  render();
}

function renderTabs() {
  $tabs.replaceChildren();
  for (const t of tabs) {
    const el = document.createElement('div');
    const ids = tabSessionIds(t);
    // Marked while an editor in it has unsaved changes.
    const unsaved = ids.some((id) => sessions.get(id)?.unsaved);
    el.className = 'tab' + (t === activeTab ? ' active' : '') + (unsaved ? ' unsaved' : '');
    el.dataset.tabId = t.id;
    el.draggable = true;
    const count = ids.length;
    el.innerHTML = '<span class="tab-name"></span><span class="tab-count"></span><button class="tab-close" title="Close tab">✕</button>';
    const name = el.querySelector('.tab-name');
    name.textContent = t.name;
    el.querySelector('.tab-count').textContent = count ? count : '';
    el.title = 'Double-click to rename. Drag a pane here to move it to this tab.';

    el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) switchTab(t); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openTabMenu(t, e.clientX, e.clientY); });
    el.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });

    name.addEventListener('dblclick', () => {
      name.contentEditable = 'true';
      el.draggable = false;
      name.focus();
      document.getSelection().selectAllChildren(name);
    });
    name.addEventListener('blur', () => {
      name.contentEditable = 'false';
      el.draggable = true;
      t.name = name.textContent.trim() || t.name;
      name.textContent = t.name;
      save();
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); name.blur(); }
    });

    el.addEventListener('dragstart', (e) => startDrag(e, { type: 'tab', tab: t }));
    el.addEventListener('dragend', endDrag);
    el.addEventListener('dragover', (e) => {
      const p = dragPayload;
      if (!p || !(p.type === 'tab' || p.type === 'pane')) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const p = dragPayload;
      endDrag();
      if (p?.type === 'pane') movePaneToTab(p.id, t);
      else if (p?.type === 'tab' && p.tab !== t) {
        tabs.splice(tabs.indexOf(p.tab), 1);
        tabs.splice(tabs.indexOf(t) + (e.offsetX > el.offsetWidth / 2 ? 1 : 0), 0, p.tab);
        render();
      }
    });
    $tabs.append(el);
  }
  const add = document.createElement('button');
  add.id = 'new-tab';
  add.textContent = '+';
  add.title = 'New tab (Ctrl+Shift+T)';
  add.addEventListener('click', newTab);
  $tabs.append(add);
}

// ---------------------------------------------------------------- rendering

function render() {
  $layout.replaceChildren();
  if (!tree) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Right-click (or hold right-click) to start a session. Ctrl+Shift+N: new Claude.';
    attachEmptyDrop(empty);
    $layout.append(empty);
  } else {
    $layout.append(build(tree));
  }

  $layout.classList.toggle('zoomed', zoomedId != null);
  for (const s of sessions.values()) s.el.classList.toggle('zoom', s.id === zoomedId);

  renderTray();
  renderTabs();
  setFocus(focusedId);
  save();

  requestAnimationFrame(() => {
    for (const s of sessions.values()) {
      if (!s.el.isConnected) continue;
      if (!s.opened) ensureOpened(s);
      else fitSession(s);
    }
    // App windows in other tabs, parked or behind a maximized pane hide.
    syncApps();
    // An app window isn't handed the keyboard here; clicking it does that.
    const f = sessions.get(focusedId);
    if (f && f.kind !== 'app') focusPane(f);
  });
  // Layout is settled by now; fit again in case a pane's size changed after
  // the first pass (a closed pane's neighbours growing, say).
  setTimeout(() => {
    for (const s of sessions.values()) if (s.el.isConnected && s.opened) fitSession(s);
    syncApps();
  }, 120);
}

function build(node) {
  if (node.type === 'leaf') return sessions.get(node.id).el;
  const box = document.createElement('div');
  box.className = `split ${node.dir}`;
  node.children.forEach((child, i) => {
    if (i > 0) box.append(makeGutter(node, i - 1, box));
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.flex = `${node.sizes[i]} 1 0`;
    cell.append(build(child));
    box.append(cell);
  });
  return box;
}

function makeGutter(node, i, box) {
  const g = document.createElement('div');
  g.className = 'gutter';
  g.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const cells = [...box.children].filter((c) => c.classList.contains('cell'));
    const a = cells[i];
    const b = cells[i + 1];
    const horiz = node.dir === 'row';
    const start = horiz ? e.clientX : e.clientY;
    const sizeA = horiz ? a.offsetWidth : a.offsetHeight;
    const sizeB = horiz ? b.offsetWidth : b.offsetHeight;
    const weight = node.sizes[i] + node.sizes[i + 1];
    const MIN = 120;
    g.classList.add('dragging');
    document.body.style.cursor = horiz ? 'col-resize' : 'row-resize';

    const onMove = (ev) => {
      const delta = (horiz ? ev.clientX : ev.clientY) - start;
      const na = Math.max(MIN, Math.min(sizeA + sizeB - MIN, sizeA + delta));
      node.sizes[i] = (weight * na) / (sizeA + sizeB);
      node.sizes[i + 1] = weight - node.sizes[i];
      a.style.flex = `${node.sizes[i]} 1 0`;
      b.style.flex = `${node.sizes[i + 1]} 1 0`;
      syncApps();
    };
    const onUp = () => {
      g.classList.remove('dragging');
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      save();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  // Double-click a gutter to make its two neighbours equal.
  g.addEventListener('dblclick', () => {
    const avg = (node.sizes[i] + node.sizes[i + 1]) / 2;
    node.sizes[i] = node.sizes[i + 1] = avg;
    render();
  });
  return g;
}

function renderTray() {
  $trayItems.replaceChildren();
  for (const id of parked) {
    const s = sessions.get(id);
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.kind = s.kind;
    chip.draggable = true;
    chip.title = `${s.cwd}\nClick to restore, or drag onto a pane`;
    chip.innerHTML = '<span class="dot"></span><span></span>';
    chip.lastChild.textContent = s.title + (s.exited ? ' (exited)' : '');
    chip.addEventListener('click', () => unpark(id));
    chip.addEventListener('dragstart', (e) => startDrag(e, { type: 'pane', id }));
    chip.addEventListener('dragend', endDrag);
    $trayItems.append(chip);
  }
  $tray.style.display = parked.length ? '' : 'none';
}

// ---------------------------------------------------------------- drag & drop

function startDrag(e, payload) {
  dragPayload = payload;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'deck');
  // Showing the overlays inside dragstart would cancel the drag in Chromium.
  setTimeout(() => {
    document.body.classList.add('dragging');
    $tray.style.display = '';
  }, 0);
}

function endDrag() {
  dragPayload = null;
  document.body.classList.remove('dragging');
  document.querySelectorAll('.drop-hint').forEach((h) => { h.style.display = 'none'; });
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  renderTray();
}

function zoneFor(e, el, allowCenter) {
  const r = el.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  const edges = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const [side, dist] = Object.entries(edges).sort((a, b) => a[1] - b[1])[0];
  if (allowCenter && dist > 0.3) return 'center';
  return side;
}

const HINT_RECT = {
  left: ['0', '0', '50%', '100%'],
  right: ['50%', '0', '50%', '100%'],
  top: ['0', '0', '100%', '50%'],
  bottom: ['0', '50%', '100%', '50%'],
  center: ['20%', '20%', '60%', '60%'],
};

function showHint(overlay, zone) {
  const [l, t, w, h] = HINT_RECT[zone];
  Object.assign(overlay.firstElementChild.style, { display: 'block', left: l, top: t, width: w, height: h });
}

function attachDropZone(overlay, targetId) {
  const hint = overlay.firstElementChild;
  overlay.dataset.paneId = targetId;
  overlay.addEventListener('dragover', (e) => {
    if (!dragPayload || dragPayload.type === 'tab') return;
    if (dragPayload.type === 'pane' && dragPayload.id === targetId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showHint(overlay, zoneFor(e, overlay, dragPayload.type === 'pane'));
  });
  overlay.addEventListener('dragleave', () => { hint.style.display = 'none'; });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    const payload = dragPayload;
    if (!payload) { endDrag(); return; }
    // Measured before endDrag(), which hides this overlay (a hidden one has no size).
    const zone = zoneFor(e, overlay, payload.type === 'pane');
    endDrag();
    handleDrop(payload, e, targetId, zone);
  });
}

function handleDrop(payload, e, targetId, side) {
  if (payload.type === 'files') dropFromExplorer(e, targetId, side);
  else movePane(payload.id, targetId, side);
}

// A folder or file dragged in from Explorer: ask what to open there.
async function dropFromExplorer(e, targetId, side) {
  const file = e.dataTransfer.files[0];
  const cwd = file && (await deck.folderForFile(file));
  if (!cwd) return;
  // A file (not a folder) can also be opened in an editor pane.
  const path = deck.pathForFile(file);
  const kind = await chooseKind(e.clientX, e.clientY, cwd, path !== cwd ? path : null);
  if (kind === 'editor') openFileInPane(path, { targetId, side });
  else if (kind) newSession(kind, { cwd, targetId, side, pick: false });
}

// Resolves a session kind ('editor' for an editor pane on `file`), or null.
function chooseKind(x, y, cwd, file) {
  return new Promise((resolve) => {
    const menu = document.createElement('div');
    menu.className = 'kind-menu';
    menu.innerHTML = '<div class="kind-menu-path"></div>';
    menu.firstChild.textContent = file || cwd;
    for (const kind of ['claude', 'cmd', 'powershell']) {
      const b = document.createElement('button');
      b.className = 'new';
      b.dataset.kind = kind;
      b.textContent = `Open ${KIND_LABEL[kind]} here`;
      b.addEventListener('click', () => done(kind));
      menu.append(b);
    }
    if (file) {
      menu.append(document.createElement('hr'));
      const b = document.createElement('button');
      b.className = 'new';
      b.dataset.kind = 'editor';
      b.textContent = 'Edit it here';
      b.addEventListener('click', () => done('editor'));
      menu.append(b);
    }
    const onKey = (ev) => { if (ev.key === 'Escape') done(null); };
    const onDown = (ev) => { if (!menu.contains(ev.target)) done(null); };
    function done(kind) {
      menu.remove();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      resolve(kind);
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
  });
}

// Drags coming from outside the app (Explorer) never fire dragstart here.
window.addEventListener('dragenter', (e) => {
  if (dragPayload || !e.dataTransfer.types.includes('Files')) return;
  dragPayload = { type: 'files' };
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (dragPayload?.type === 'files' && !e.relatedTarget) endDrag();
});
// Without this, dropping a file anywhere else would navigate the window to it.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (dragPayload?.type === 'files') endDrag();
});

function attachEmptyDrop(el) {
  el.addEventListener('dragover', (e) => {
    if (!dragPayload || dragPayload.type === 'tab') return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const payload = dragPayload;
    endDrag();
    if (payload && payload.type !== 'tab') handleDrop(payload, e, null, 'right');
  });
}

$tray.addEventListener('dragover', (e) => {
  if (dragPayload?.type !== 'pane' || parked.includes(dragPayload.id)) return;
  e.preventDefault();
  $tray.classList.add('drop-target');
});
$tray.addEventListener('dragleave', () => $tray.classList.remove('drop-target'));
$tray.addEventListener('drop', (e) => {
  e.preventDefault();
  const payload = dragPayload;
  endDrag();
  if (payload?.type === 'pane') park(payload.id);
});

// ---------------------------------------------------------------- menus & wheel
//
// Right-click in a pane: a menu opens and, while it's open, the pane previews
// where a new one would go (the edge nearest the click, as if dragged there).
// Any click elsewhere just closes it and does what that click normally does.
// Hold right-click instead: a wheel pops up; move towards a slot and release.
// Right-click on a pane's title bar: rename / recolour. On a tab or the bars
// above the panes: layouts (see "layouts" below).

const PALETTE = ['#d97757', '#e0af68', '#9ece6a', '#73daca', '#7dcfff', '#7aa2f7', '#bb9af7', '#f7768e', '#c0caf5'];

// What a menu entry or wheel slot can do. `place` ones open a pane, so they
// show the placement preview; the others act on the right-clicked pane.
const ACTIONS = {
  claude: { label: 'Claude', kind: 'claude', place: true },
  cmd: { label: SHELL_LABEL, kind: 'cmd', place: true },
  powershell: { label: 'PowerShell', kind: 'powershell', place: true },
  duplicate: { label: 'Duplicate', place: true },
  editor: { label: 'Open file…', kind: 'editor', place: true },
  newfile: { label: 'New file', kind: 'editor', place: true },
  browser: { label: 'Browser', kind: 'browser', place: true },
  park: { label: 'Park' },
  zoom: { label: 'Maximize' },
  popout: { label: 'Pop out' },
  close: { label: 'Close' },
  rename: { label: 'Rename' },
  none: { label: '(empty)' },
};
const MENU_ACTIONS = ['claude', 'duplicate', 'cmd', 'powershell', 'editor', 'browser'];

// Clockwise from the right: the 8 sectors of the wheel.
const SLOTS = ['right', 'downRight', 'down', 'downLeft', 'left', 'upLeft', 'up', 'upRight'];
const DEFAULT_WHEEL = {
  up: 'claude', right: 'cmd', down: 'powershell', left: 'duplicate',
  upLeft: 'park', upRight: 'zoom', downRight: 'close', downLeft: 'popout',
};
let wheelCfg = { ...DEFAULT_WHEEL };

const WHEEL_HOLD_MS = 180;
const WHEEL_MOVE_PX = 6;
const WHEEL_DEAD_PX = 28;
const WHEEL_RADIUS = 104;

let popup = null;
const closePopup = () => popup?.();

// ctx = { s, x, y }: the pane right-clicked and where; null in an empty tab.
function showPreview(ctx) {
  if (!ctx) return null;
  const overlay = ctx.s.el.querySelector('.drop-overlay');
  const side = zoneFor({ clientX: ctx.x, clientY: ctx.y }, ctx.s.el, true);
  return { overlay, side };
}

function setPreview(p, on) {
  if (!p) return;
  p.overlay.classList.toggle('preview', on);
  if (on) showHint(p.overlay, p.side);
  else p.overlay.firstElementChild.style.display = 'none';
}

function duplicateKind(s) {
  if (s.kind.startsWith('claude')) return 'claude';
  return s.kind === 'docked' || s.kind === 'app' || s.kind === 'editor' ? 'cmd' : s.kind;
}

function runAction(name, ctx, preview) {
  const a = ACTIONS[name];
  if (!a || name === 'none') return;
  const s = ctx?.s;
  if (name === 'editor') {
    openFileFromMenu(ctx, preview);
  } else if (a.place) {
    // Same folder as the pane it was opened from, no folder question for those.
    const kind = name === 'duplicate' ? s && duplicateKind(s) : a.kind;
    if (!kind) return;
    newSession(kind, {
      cwd: s?.cwd, targetId: s?.id ?? null, side: preview?.side ?? 'right', pick: name !== 'duplicate',
      // A duplicated browser pane shows the same page.
      extra: name === 'duplicate' && s?.kind === 'browser' ? { url: s.url } : undefined,
    });
  } else if (s) {
    if (name === 'park') park(s.id);
    else if (name === 'zoom') toggleZoom(s.id);
    else if (name === 'close') closeSession(s.id);
    else if (name === 'popout') popOut(s);
    else if (name === 'rename') setTimeout(() => startRename(s));
  }
}

// items: { label, kind?, run } | { swatches: [...], pick } | { sep: true }.
// `preview`: pane preview shown for as long as the menu is open.
function showMenu(x, y, items, preview) {
  closePopup();
  setPreview(preview, true);
  const menu = document.createElement('div');
  menu.className = 'kind-menu';
  for (const it of items) {
    if (it.sep) {
      menu.append(document.createElement('hr'));
    } else if (it.swatches) {
      const row = document.createElement('div');
      row.className = 'swatches';
      for (const c of it.swatches) {
        const b = document.createElement('button');
        b.className = 'swatch' + (c === it.current ? ' on' : '');
        b.style.background = c;
        b.addEventListener('click', () => { closePopup(); it.pick(c); });
        row.append(b);
      }
      menu.append(row);
    } else {
      const b = document.createElement('button');
      if (it.kind) { b.className = 'new'; b.dataset.kind = it.kind; }
      b.textContent = it.label;
      b.addEventListener('click', () => { closePopup(); it.run(); });
      menu.append(b);
    }
  }
  const onKey = (ev) => { if (ev.key === 'Escape') closePopup(); };
  // Not stopped: the click that closes the menu still does its usual job.
  const onDown = (ev) => { if (!menu.contains(ev.target)) closePopup(); };
  popup = () => {
    popup = null;
    menu.remove();
    setPreview(preview, false);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', closePopup);
  };
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 8))}px`;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('blur', closePopup);
}

function openPaneMenu(ctx, x, y) {
  const preview = showPreview(ctx);
  const items = MENU_ACTIONS
    .filter((n) => ctx || n !== 'duplicate')
    .map((n) => ({ label: ACTIONS[n].label, kind: ACTIONS[n].kind || (ctx && duplicateKind(ctx.s)), run: () => runAction(n, ctx, preview) }));
  if (ctx?.s.kind === 'editor') {
    items.splice(MENU_ACTIONS.indexOf('editor') + 1, 0, { label: ACTIONS.newfile.label, kind: 'editor', run: () => runAction('newfile', ctx, preview) });
    items.push(...editorMenuItems(ctx.s));
    const text = editorSelection(ctx.s);
    for (const target of text ? claudeTargets(ctx.s) : []) {
      items.push({ label: `Send to ${target.label}`, kind: 'claude', run: () => pasteToClaude(text, target.s) });
    }
  } else if (ctx?.s.term.element && ctx.s.term.hasSelection()) {
    items.push({ sep: true }, {
      label: 'Copy',
      run: () => {
        const s = ctx.s;
        deck.copy(s.psel ? promptSelText(s) : s.term.getSelection());
        s.term.clearSelection();
        s.psel = null;
      },
    });
    for (const target of claudeTargets(ctx.s)) {
      items.push({ label: `Send to ${target.label}`, kind: 'claude', run: () => sendToClaude(ctx.s, target.s) });
    }
  }
  // Any open window can be docked: dragged in (Windows) or picked from a list.
  const side = preview?.side ?? 'right';
  items.push({ sep: true }, { label: 'Dock a window…', run: () => pickWindowToDock(x, y, ctx?.s.id ?? null, side) });
  if (ctx) items.push({ sep: true }, { label: ACTIONS.close.label, run: () => runAction('close', ctx, preview) });
  showMenu(x, y, items, preview);
}

// Linux: a list of the open windows to dock (see linuxdock.js).
async function pickWindowToDock(x, y, targetId, side) {
  const list = await deck.dockableWindows();
  const docked = new Set([...sessions.values()].map((s) => s.hwnd).filter(Boolean));
  const items = (list || []).filter((w) => !docked.has(w.id)).map((w) => ({
    label: w.title.length > 60 ? `${w.title.slice(0, 59)}…` : w.title,
    kind: 'app',
    run: () => dockWindow(w.id, targetId, side),
  }));
  if (!items.length) {
    items.push({
      label: list ? 'No other windows to dock' : 'Docking needs X11 (or XWayland) with xdotool and xprop installed',
      run: () => {},
    });
  }
  showMenu(x, y, items);
}

function openHeaderMenu(s, x, y) {
  showMenu(x, y, [
    { label: 'Rename', run: () => startRename(s) },
    { swatches: PALETTE, current: s.color, pick: (c) => { setColor(s, c); save(); } },
    { label: 'Default colour', run: () => { setColor(s, null); save(); } },
    ...(s.kind === 'cmd' || s.kind === 'powershell' ? [{ label: s.run ? `Start command: ${s.run}` : 'Start command…', run: () => askRun(s) }] : []),
    ...linkItems(s),
  ]);
}

// A command typed into a shell pane every time it starts (also after a
// restart of VibeCMD), e.g. a dev server.
async function askRun(s) {
  const run = await askText('Command to run whenever this pane starts (empty for none)', s.run || '');
  if (run === null) return;
  s.run = run || null;
  save();
}

// Picks on release of the right button, by direction from where it was pressed
// (the pointer may be over the wheel, a pane or anywhere else).
function openWheel(ctx, x, y) {
  closePopup();
  const preview = showPreview(ctx);
  const wheel = document.createElement('div');
  wheel.className = 'wheel';
  wheel.style.left = `${Math.max(WHEEL_RADIUS + 70, Math.min(x, innerWidth - WHEEL_RADIUS - 70))}px`;
  wheel.style.top = `${Math.max(WHEEL_RADIUS + 20, Math.min(y, innerHeight - WHEEL_RADIUS - 20))}px`;
  const els = {};
  SLOTS.forEach((slot, i) => {
    const name = wheelCfg[slot] || 'none';
    // Pane actions mean nothing in an empty tab (no pane to act on).
    if (name === 'none' || (!ctx && !ACTIONS[name].place) || (!ctx && name === 'duplicate')) return;
    const a = (i * Math.PI) / 4;
    const el = document.createElement('span');
    el.textContent = ACTIONS[name].label;
    el.dataset.kind = ACTIONS[name].kind || '';
    el.style.left = `calc(50% + ${Math.round(Math.cos(a) * WHEEL_RADIUS)}px)`;
    el.style.top = `calc(50% + ${Math.round(Math.sin(a) * WHEEL_RADIUS)}px)`;
    wheel.append(el);
    els[slot] = { el, name };
  });
  let slot = null;
  const onMove = (ev) => {
    const dx = ev.clientX - x;
    const dy = ev.clientY - y;
    const next = Math.hypot(dx, dy) < WHEEL_DEAD_PX ? null
      : SLOTS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
    if (next === slot) return;
    slot = els[next] ? next : null;
    for (const k in els) els[k].el.classList.toggle('active', k === slot);
    setPreview(preview, !!slot && !!ACTIONS[els[slot].name].place);
  };
  const onUp = (ev) => {
    if (ev.button !== 2) return;
    const name = els[slot]?.name;
    closePopup();
    if (name) runAction(name, ctx, preview);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') closePopup(); };
  popup = () => {
    popup = null;
    wheel.remove();
    setPreview(preview, false);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closePopup);
  };
  document.body.append(wheel);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closePopup);
  return true;
}

$layout.addEventListener('mousedown', (e) => {
  if (e.button !== 2 || e.target.closest('.pane-head')) return; // title bars have their own menu
  const paneEl = e.target.closest('.pane');
  if (!paneEl && !e.target.closest('.empty')) return;
  // Before xterm sees it: no focus change, no word selection, no mouse reporting.
  e.preventDefault();
  e.stopPropagation();
  closePopup();
  const { clientX: x, clientY: y } = e;
  const ctx = paneEl ? { s: sessions.get(+paneEl.dataset.id), x, y } : null;
  let wheel = false;
  const start = () => { wheel = openWheel(ctx, x, y); };
  const timer = setTimeout(start, WHEEL_HOLD_MS);
  const onMove = (ev) => {
    if (!wheel && Math.hypot(ev.clientX - x, ev.clientY - y) > WHEEL_MOVE_PX) { clearTimeout(timer); start(); }
  };
  const onUp = (ev) => {
    if (ev.button !== 2) return;
    clearTimeout(timer);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    // A short click opens the menu; a held one was the wheel, which picks itself.
    if (!wheel) openPaneMenu(ctx, x, y);
  };
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
}, true);

// The browser's own context menu never shows over the panes.
$layout.addEventListener('contextmenu', (e) => e.preventDefault(), true);

// ---------------------------------------------------------------- layouts
//
// A saved layout is a tab's arrangement, a whole working set: for each pane
// its kind, folder, title and colour, plus a shell pane's start command, an
// editor pane's file and which editor shows a Claude pane's edits. Claude
// panes open a fresh chat in their folder (or, set in the editor, continue
// that folder's last one). Opening one makes a new tab; "Open in…" opens it
// for another folder, with every path in it moved along. Right-click a tab
// to save it, or the bar above the panes to open / manage layouts.

let layouts = [];
let nextLayoutId = 1;

// The tab's panes as a template tree; null if it has none that can be saved.
function templateOf(t) {
  const ser = (node) => {
    if (!node) return null;
    if (node.type === 'leaf') {
      const s = sessions.get(node.id);
      if (s.kind === 'docked') return null;
      return {
        type: 'leaf', kind: s.kind === 'claude-continue' ? 'claude' : s.kind, cwd: s.cwd, title: s.title, color: s.color,
        uid: s.uid, link: s.link, linkEditor: s.linkEditor, run: s.run, app: s.app ? { ...s.app } : null,
        ...(s.kind === 'editor' ? editorState(s) : {}), url: s.url,
      };
    }
    const children = node.children.map(ser);
    return {
      type: 'split', dir: node.dir,
      sizes: node.sizes.filter((_, i) => children[i]),
      children: children.filter(Boolean),
    };
  };
  if (t === activeTab) stashTab();
  return normalize(ser(t.tree));
}

function openLayout(l, tree = l.tree) {
  stashTab();
  const t = makeTab(l.name);
  tabs.push(t);
  // Every pane gets a new uid; links between the layout's panes follow.
  const uids = new Map();
  const made = [];
  const des = (node) => {
    if (node.type === 'leaf') {
      const s = createSession({
        kind: node.kind, cwd: node.cwd, title: node.title, color: node.color,
        run: node.run, app: node.app, linkEditor: node.linkEditor, link: node.link,
        files: node.files, file: node.file, url: node.url,
      });
      if (node.uid) uids.set(node.uid, s.uid);
      made.push(s);
      return leaf(s.id);
    }
    return split(node.dir, node.children.map(des), [...node.sizes]);
  };
  t.tree = normalize(des(structuredClone(tree)));
  for (const s of made) if (s.link) s.link = uids.get(s.link) || null;
  t.focusedId = leafIds(t.tree)[0] ?? null;
  loadTab(t);
  render();
}

// The folder every path in a layout is under (null if they share none).
function layoutRoot(tree) {
  const dirs = [];
  const walk = (n) => {
    if (n.type === 'split') { n.children.forEach(walk); return; }
    if (n.cwd) dirs.push(n.cwd);
  };
  walk(tree);
  if (!dirs.length) return null;
  const parts = dirs.map((d) => d.replace(/[\/]+$/, '').split(/[\/]/));
  const common = [];
  for (let i = 0; parts.every((p) => i < p.length && samePath(p[i], parts[0][i])); i++) common.push(parts[0][i]);
  if (!common.length || (common.length === 1 && !common[0])) return null;
  return common.join(IS_WIN ? '\\' : '/');
}

// The layout with every path under `from` moved under `to`.
function rebaseLayout(tree, from, to) {
  const under = (p) => p && p.length >= from.length && samePath(p.slice(0, from.length), from) && /^([\\/]|$)/.test(p.slice(from.length));
  const move = (p) => (under(p) ? to + p.slice(from.length) : p);
  const out = structuredClone(tree);
  const walk = (n) => {
    if (n.type === 'split') { n.children.forEach(walk); return; }
    n.cwd = move(n.cwd);
    if (n.files) n.files = n.files.map(move);
    if (n.file) n.file = move(n.file);
    // Layouts saved while editor panes docked an outside editor.
    if (n.app?.file) n.app.file = move(n.app.file);
  };
  walk(out);
  return out;
}

async function openLayoutIn(l) {
  const from = layoutRoot(l.tree);
  const to = await deck.pickFolder({ defaultPath: from || defaultCwd, title: `Open "${l.name}" for which folder?`, buttonLabel: 'Open here' });
  if (!to) return;
  openLayout(l, from ? rebaseLayout(l.tree, from, to) : l.tree);
}

async function saveTabAsLayout(t) {
  const tree = templateOf(t);
  if (!tree) return;
  const name = await askText('Save layout as', t.name);
  if (!name) return;
  const existing = layouts.find((l) => l.name === name);
  if (existing) existing.tree = tree;
  else layouts.push({ id: nextLayoutId++, name, tree });
  save();
}

function layoutItems() {
  const items = layouts.map((l) => ({ label: l.name, run: () => openLayout(l) }));
  if (!items.length) items.push({ label: '(no saved layouts yet)', run: () => {} });
  return items;
}

function openBarMenu(x, y) {
  showMenu(x, y, [...layoutItems(), { sep: true }, { label: 'Layout settings…', run: openLayoutSettings }]);
}

function openTabMenu(t, x, y) {
  const canSave = !!templateOf(t);
  showMenu(x, y, [
    ...(canSave ? [{ label: 'Save layout…', run: () => saveTabAsLayout(t) }] : []),
    { label: 'Open layout…', run: () => setTimeout(() => openBarMenu(x, y)) },
    { label: 'Layout settings…', run: openLayoutSettings },
    { sep: true },
    { label: 'Close tab', run: () => closeTab(t) },
  ]);
}

// Right-click on the strip above the panes (not on a tab or control).
for (const bar of [$tabs, document.getElementById('toolbar')]) {
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.target.closest('.tab, button, select')) return;
    openBarMenu(e.clientX, e.clientY);
  });
}

// ---- small dialogs

function modal(card, onClose) {
  const back = document.createElement('div');
  back.className = 'modal';
  back.append(card);
  const close = () => {
    if (!back.isConnected) return;
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  return close;
}

// (window.prompt isn't available in Electron.) Resolves null if dismissed, ''
// if OK'd empty.
function askText(title, initial = '') {
  return new Promise((resolve) => {
    const card = document.createElement('form');
    card.className = 'help-card ask';
    card.innerHTML = '<h3></h3><input type="text" spellcheck="false" /><div class="row"><button type="button" class="cancel">Cancel</button><button class="ok">OK</button></div>';
    card.querySelector('h3').textContent = title;
    const input = card.querySelector('input');
    input.value = initial;
    let value = null;
    const close = modal(card, () => resolve(value));
    card.addEventListener('submit', (e) => { e.preventDefault(); value = input.value.trim(); close(); });
    card.querySelector('.cancel').addEventListener('click', close);
    input.focus();
    input.select();
  });
}

// ---- layout settings: list, rename, delete; click one to edit it

function openLayoutSettings() {
  const card = document.createElement('div');
  card.className = 'help-card settings';
  let close;
  const draw = () => {
    card.replaceChildren();
    const h = document.createElement('h2');
    h.textContent = 'Layout settings';
    card.append(h);
    const tip = document.createElement('p');
    tip.className = 'muted';
    tip.textContent = 'Opening a layout makes a new tab with all its panes, start commands and editor files. "Open in…" does it for another project folder.';
    card.append(tip);
    if (!layouts.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No saved layouts. Right-click a tab and choose "Save layout…".';
      card.append(p);
    }
    for (const l of layouts) {
      const row = document.createElement('div');
      row.className = 'layout-row';
      const name = document.createElement('button');
      name.className = 'layout-name';
      name.textContent = `${l.name}  (${leafCount(l.tree)} panes)`;
      name.title = 'Edit this layout';
      name.addEventListener('click', () => { close(); openLayoutEditor(l); });
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.addEventListener('click', () => { close(); openLayout(l); });
      const openIn = document.createElement('button');
      openIn.textContent = 'Open in…';
      openIn.title = 'Open it for another folder: every pane\'s folder (and editor file) moves along';
      openIn.addEventListener('click', () => { close(); openLayoutIn(l); });
      const ren = document.createElement('button');
      ren.textContent = 'Rename';
      ren.addEventListener('click', async () => {
        const n = await askText('Rename layout', l.name);
        if (n) { l.name = n; save(); draw(); }
      });
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.className = 'danger';
      del.addEventListener('click', () => {
        if (!confirm(`Delete layout "${l.name}"?`)) return;
        layouts = layouts.filter((x) => x !== l);
        save();
        draw();
      });
      row.append(name, open, openIn, ren, del);
      card.append(row);
    }
    const wh = document.createElement('h3');
    wh.textContent = 'Hold-right-click wheel';
    card.append(wh);
    const grid = document.createElement('div');
    grid.className = 'wheel-cfg';
    for (const slot of ['upLeft', 'up', 'upRight', 'left', null, 'right', 'downLeft', 'down', 'downRight']) {
      if (!slot) { grid.append(document.createElement('span')); continue; }
      const sel = document.createElement('select');
      for (const [k, a] of Object.entries(ACTIONS)) sel.add(new Option(a.label, k));
      sel.value = wheelCfg[slot] || 'none';
      sel.addEventListener('change', () => { wheelCfg[slot] = sel.value; save(); });
      grid.append(sel);
    }
    card.append(grid);
    const done = document.createElement('button');
    done.textContent = 'Close';
    done.addEventListener('click', () => close());
    card.append(done);
  };
  close = modal(card);
  draw();
}

const leafCount = (node) => (node.type === 'leaf' ? 1 : node.children.reduce((n, c) => n + leafCount(c), 0));

// ---- layout editor: the template as boxes; change any pane, split, remove

const EDIT_KINDS = {
  claude: 'Claude', 'claude-continue': 'Claude (continue last chat)', cmd: SHELL_LABEL, powershell: 'PowerShell', editor: 'Editor', browser: 'Browser',
};

function openLayoutEditor(layout) {
  const work = { name: layout.name, tree: structuredClone(layout.tree) };
  const card = document.createElement('div');
  card.className = 'help-card editor';
  let close;
  let root = work.tree;

  const replaceNode = (old, fresh) => {
    const hit = findIn(root, old);
    if (hit.parent) hit.parent.children[hit.index] = fresh;
    else root = fresh;
  };
  const findIn = (node, target, parent = null, index = -1) => {
    if (node === target) return { parent, index };
    if (node.type === 'split') {
      for (let i = 0; i < node.children.length; i++) {
        const r = findIn(node.children[i], target, node, i);
        if (r) return r;
      }
    }
    return null;
  };
  const splitAt = (node, dir) => {
    const fresh = { type: 'leaf', kind: node.kind === 'powershell' ? 'powershell' : 'cmd', cwd: node.cwd, title: SHELL_LABEL, color: null };
    const { parent, index } = findIn(root, node);
    if (parent && parent.dir === dir) {
      const half = parent.sizes[index] / 2;
      parent.sizes[index] = half;
      parent.children.splice(index + 1, 0, fresh);
      parent.sizes.splice(index + 1, 0, half);
    } else {
      replaceNode(node, { type: 'split', dir, children: [node, fresh], sizes: [1, 1] });
    }
  };
  const removeNode = (node) => {
    const { parent, index } = findIn(root, node);
    if (!parent) { root = null; return; }
    parent.children.splice(index, 1);
    parent.sizes.splice(index, 1);
    root = normalize(root);
  };

  const leafBox = (node) => {
    const box = document.createElement('div');
    box.className = 'ed-leaf';
    if (node.color) box.style.setProperty('--pc', node.color);
    // Saved while editor panes docked an outside editor.
    if (node.kind === 'app' && node.app?.file) {
      node.kind = 'editor';
      node.files = [node.app.file];
      node.app = null;
    }
    const kind = document.createElement('select');
    for (const [k, label] of Object.entries(EDIT_KINDS)) kind.add(new Option(label, k));
    // A docked app stays one.
    if (node.kind === 'app') {
      kind.add(new Option(`App: ${folderName(node.app?.exe || 'app')}`, 'app'));
      kind.disabled = true;
    }
    kind.value = node.kind;
    kind.addEventListener('change', () => { node.kind = kind.value; draw(); });
    const title = document.createElement('input');
    title.value = node.title;
    title.addEventListener('input', () => { node.title = title.value; });
    const dir = document.createElement('button');
    dir.className = 'ed-dir';
    if (node.kind === 'editor') {
      const files = node.files || [];
      dir.textContent = files.length ? `📄 ${files.map(folderName).join(', ')}` : '📄 (no file, click to pick)';
      dir.title = files.join('\n');
      dir.addEventListener('click', async () => {
        const f = await deck.pickFile({ defaultPath: files[0] || node.cwd, title: 'File for this editor pane' });
        if (!f) return;
        node.files = [f];
        node.file = f;
        node.cwd = f.replace(/[\\/][^\\/]*$/, '');
        draw();
      });
    } else if (node.kind === 'browser') {
      dir.textContent = `🌐 ${node.url || HOME_URL}`;
      dir.addEventListener('click', async () => {
        const u = await askText('Address for this browser pane', node.url || '');
        if (u) { node.url = toUrl(u); draw(); }
      });
    } else {
      dir.textContent = `📁 ${node.cwd}`;
      dir.title = node.cwd;
      dir.addEventListener('click', async () => {
        const d = await deck.pickFolder({ defaultPath: node.cwd, title: 'Folder for this pane' });
        if (d) { node.cwd = d; draw(); }
      });
    }
    // Shells: typed in whenever the pane starts.
    const run = document.createElement('input');
    run.placeholder = 'Start command (optional)';
    run.value = node.run || '';
    run.addEventListener('input', () => { node.run = run.value.trim() || null; });
    const showRun = node.kind === 'cmd' || node.kind === 'powershell';
    const sw = document.createElement('div');
    sw.className = 'swatches';
    for (const c of [null, ...PALETTE]) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === (node.color || null) ? ' on' : '') + (c ? '' : ' none');
      if (c) b.style.background = c;
      b.title = c ? c : 'Default colour';
      b.addEventListener('click', () => { node.color = c; draw(); });
      sw.append(b);
    }
    const acts = document.createElement('div');
    acts.className = 'ed-acts';
    for (const [label, tip, fn] of [
      ['⇥', 'Split: new pane to the right', () => splitAt(node, 'row')],
      ['⤓', 'Split: new pane below', () => splitAt(node, 'col')],
      ['✕', 'Remove this pane', () => removeNode(node)],
    ]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = tip;
      b.addEventListener('click', () => { fn(); draw(); });
      acts.append(b);
    }
    box.append(kind, title, dir, ...(showRun ? [run] : []), sw, acts);
    return box;
  };

  const build = (node) => {
    if (node.type === 'leaf') return leafBox(node);
    const box = document.createElement('div');
    box.className = `ed-split ${node.dir}`;
    node.children.forEach((c, i) => {
      const cell = document.createElement('div');
      cell.className = 'ed-cell';
      cell.style.flex = `${node.sizes[i]} 1 0`;
      cell.append(build(c));
      box.append(cell);
    });
    return box;
  };

  const draw = () => {
    card.replaceChildren();
    const head = document.createElement('div');
    head.className = 'row';
    const name = document.createElement('input');
    name.className = 'ed-name';
    name.value = work.name;
    name.addEventListener('input', () => { work.name = name.value; });
    const even = document.createElement('button');
    even.textContent = 'Even out';
    even.addEventListener('click', () => {
      const f = (n) => { if (n?.type === 'split') { n.sizes = n.children.map(() => 1); n.children.forEach(f); } };
      f(root);
      draw();
    });
    head.append(name, even);
    const area = document.createElement('div');
    area.className = 'ed-area';
    if (root) area.append(build(root));
    else {
      const add = document.createElement('button');
      add.textContent = '+ Add a pane';
      add.addEventListener('click', () => { root = { type: 'leaf', kind: 'cmd', cwd: defaultCwd, title: SHELL_LABEL, color: null }; draw(); });
      area.append(add);
    }
    const foot = document.createElement('div');
    foot.className = 'row';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { close(); openLayoutSettings(); });
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'ok';
    saveBtn.disabled = !root;
    saveBtn.addEventListener('click', () => {
      layout.name = work.name.trim() || layout.name;
      layout.tree = root;
      save();
      close();
      openLayoutSettings();
    });
    foot.append(cancel, saveBtn);
    card.append(head, area, foot);
  };
  close = modal(card);
  draw();
}

// ---------------------------------------------------------------- keyboard selection
//
// Claude's prompt has no selection of its own, so VibeCMD keeps one. Shift
// (+Ctrl) + Left/Right/Home/End are sent to Claude as the plain keys (Claude
// ignores Shift anyway, so its cursor moves as usual) while VibeCMD counts the
// characters passed over and highlights them. Typing or pasting then first
// removes that many characters with Backspace or Delete, so Claude only ever
// sees ordinary keys. Ctrl+A selects the whole prompt.
//
// After a click (or a mouse selection) in the output above the prompt, the
// same keys, plus Shift+Up/Down, select text there instead, for copying.

const PROMPT_COL = 2; // prompt text starts after "❯ " (or the indent on later lines)
const SELECT_KEYS = new Set(['ARROWLEFT', 'ARROWRIGHT', 'ARROWUP', 'ARROWDOWN', 'HOME', 'END']);

function sendKeys(s, data) {
  if (s.hwnd) deck.writeWindow(s.hwnd, data);
  else if (s.ptyId != null) deck.write(s.ptyId, data);
}

const lineText = (s, y) => s.term.buffer.active.getLine(y)?.translateToString(true) ?? '';

// The buffer rows of Claude's prompt box (between its two ─── rules) around
// the cursor; null when the pane isn't showing one.
function promptRows(s) {
  const b = s.term.buffer.active;
  const cy = b.baseY + b.cursorY;
  const rule = (y) => lineText(s, y).startsWith('─');
  let top = cy, bottom = cy;
  while (top > b.baseY && !rule(top)) top--;
  while (bottom < b.baseY + s.term.rows - 1 && !rule(bottom)) bottom++;
  if (top === cy || !rule(top) || !rule(bottom) || !/^\S/.test(lineText(s, top + 1))) return null;
  return { first: top + 1, last: bottom - 1 };
}

// The characters of one prompt row with the column each starts at (wide
// characters take two), leaving out the padding at its end. Dim text is
// Claude's placeholder or a suggestion, not something typed.
function promptChars(s, y) {
  const line = s.term.buffer.active.getLine(y);
  const chars = [];
  for (let x = PROMPT_COL; line && x < line.length; x++) {
    const cell = line.getCell(x);
    if (cell.isDim()) break;
    // Claude skips over spaces rather than writing them, leaving those cells empty.
    if (cell.getWidth()) chars.push({ x, ch: cell.getChars() || ' ' });
  }
  while (chars.length && chars.at(-1).ch === ' ') chars.pop();
  return chars;
}

// Only moves Claude's cursor can surely make are counted (Left at the very
// start, for one, does nothing), so the count always matches the characters
// actually selected. Claude takes a moment to show each move, so after the
// first key the caret is tracked here (prompt row and character on it)
// rather than read back from the screen.
function selectInPrompt(s, key, word) {
  const p = promptRows(s);
  if (!p) return false;
  const b = s.term.buffer.active;
  if (!s.psel || s.psel.all) {
    const cy = b.baseY + b.cursorY;
    const at = promptChars(s, cy).filter((c) => c.x < b.cursorX).length;
    s.psel = { row: cy - p.first, x: b.cursorX, count: 0, caret: { row: cy - p.first, at } };
  }
  const caret = s.psel.caret;
  const chars = promptChars(s, p.first + caret.row);
  const space = (i) => chars[i].ch === ' ';
  let at = Math.min(caret.at, chars.length), n;
  if (key === 'HOME') n = -at;
  else if (key === 'END') n = chars.length - at;
  else if (key === 'ARROWLEFT') {
    if (at === 0) n = caret.row > 0 ? -1 : 0; // to the end of the line above
    else if (!word) n = -1;
    else {
      let i = at;
      while (i > 0 && space(i - 1)) i--;
      while (i > 0 && !space(i - 1)) i--;
      n = i - at;
    }
  } else {
    if (at >= chars.length) n = p.first + caret.row < p.last ? 1 : 0;
    else if (!word) n = 1;
    else {
      let i = at;
      while (i < chars.length && !space(i)) i++;
      while (i < chars.length && space(i)) i++;
      n = i - at;
    }
  }
  if (key === 'ARROWLEFT' && at === 0 && n) {
    caret.row--;
    at = promptChars(s, p.first + caret.row).length;
  } else if (key === 'ARROWRIGHT' && at >= chars.length && n) {
    caret.row++;
    at = 0;
  } else {
    at += n;
  }
  caret.at = at;
  s.psel.count += n;
  if (n) sendKeys(s, (n < 0 ? '\x1b[D' : '\x1b[C').repeat(Math.abs(n)));
  if (!s.psel.count) s.term.clearSelection();
  return true;
}

function selectAllPrompt(s) {
  const p = promptRows(s);
  if (!p) return false;
  let cells = 0;
  for (let y = p.first; y <= p.last; y++) cells += lineText(s, y).length + 1;
  // More Left / Delete presses than there are characters: the extras do
  // nothing, except that one Delete too many leaves bash mode (the "!"
  // prompt), so it's typed again afterwards.
  s.psel = { all: true, presses: cells + 1, bash: lineText(s, p.first).startsWith('!') };
  const end = promptChars(s, p.last).at(-1);
  const from = p.first * s.term.cols + PROMPT_COL;
  const to = p.last * s.term.cols + (end ? end.x + 1 : PROMPT_COL);
  if (to > from) s.term.select(PROMPT_COL, p.first, to - from);
  return true;
}

function showPromptSel(s) {
  const p = promptRows(s);
  if (!p || s.psel.all) return;
  const b = s.term.buffer.active;
  const anchor = (p.first + s.psel.row) * s.term.cols + s.psel.x;
  const cursor = (b.baseY + b.cursorY) * s.term.cols + b.cursorX;
  const from = Math.min(anchor, cursor);
  if (!s.psel.count || anchor === cursor) s.term.clearSelection();
  else s.term.select(from % s.term.cols, Math.floor(from / s.term.cols), Math.abs(cursor - anchor));
}

function eraseSelection(sel) {
  if (sel.all) return '\x1b[D'.repeat(sel.presses) + '\x1b[3~'.repeat(sel.presses) + (sel.bash ? '!' : '');
  return sel.count > 0 ? '\x7f'.repeat(sel.count) : '\x1b[3~'.repeat(-sel.count);
}

// Backspace / Delete remove the selection, text (typed or pasted) replaces
// it, and anything else (arrows, Enter, Esc...) just drops it.
function typeOverSelection(s, data) {
  const sel = s.psel;
  s.psel = null;
  s.term.clearSelection();
  if (data === '\x7f' || data === '\b' || data === '\x1b[3~') return eraseSelection(sel);
  // A paste is bracketed by \e[200~ when the program asks for that; docked
  // windows don't pass that request on, so there it's just several characters.
  const text = data.startsWith('\x1b[200~') || (!data.startsWith('\x1b') && (data.length > 1 || data >= ' '));
  return text ? eraseSelection(sel) + data : data;
}

// The selected prompt text, without the indent Claude puts before later lines.
const promptSelText = (s) => s.term.getSelection().replace(/\n {2}/g, '\n');

// Called just after a click or mouse selection ends. A mouse selection can
// then be grown from the keyboard; a plain click in the output (not in the
// prompt, where keys belong to Claude) is where a keyboard selection starts.
function placeOutputPoint(s, e) {
  const cols = s.term.cols;
  const sel = s.term.getSelectionPosition();
  if (sel) {
    s.out = { anchor: sel.start.y * cols + sel.start.x, head: sel.end.y * cols + sel.end.x };
    return;
  }
  const screen = s.termEl.querySelector('.xterm-screen');
  if (!screen) return;
  const r = screen.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) / (r.width / cols));
  const row = Math.floor((e.clientY - r.top) / (r.height / s.term.rows));
  if (x < 0 || x > cols || row < 0 || row >= s.term.rows) return;
  const y = s.term.buffer.active.viewportY + row;
  const p = promptRows(s);
  if (p && y >= p.first && y <= p.last) return;
  s.out = { anchor: y * cols + Math.min(x, lineText(s, y).length), head: null };
  s.out.head = s.out.anchor;
}

function selectInOutput(s, key, word) {
  const cols = s.term.cols;
  const b = s.term.buffer.active;
  let y = Math.floor(s.out.head / cols), x = s.out.head % cols;
  const text = lineText(s, y);
  const space = (i) => text[i] === ' ';
  if (key === 'ARROWUP') y = Math.max(0, y - 1);
  else if (key === 'ARROWDOWN') y = Math.min(b.length - 1, y + 1);
  else if (key === 'HOME') x = 0;
  else if (key === 'END') x = text.length;
  else if (key === 'ARROWLEFT') {
    if (x === 0 && y > 0) x = lineText(s, --y).length;
    else if (!word) x = Math.max(0, x - 1);
    else {
      while (x > 0 && space(x - 1)) x--;
      while (x > 0 && !space(x - 1)) x--;
    }
  } else {
    if (x >= text.length && y < b.length - 1) { y++; x = 0; }
    else if (!word) x = Math.min(text.length, x + 1);
    else {
      while (x < text.length && !space(x)) x++;
      while (x < text.length && space(x)) x++;
    }
  }
  if (key === 'ARROWUP' || key === 'ARROWDOWN') x = Math.min(x, lineText(s, y).length);
  s.out.head = y * cols + x;
  const from = Math.min(s.out.anchor, s.out.head);
  const length = Math.abs(s.out.head - s.out.anchor);
  if (length) s.term.select(from % cols, Math.floor(from / cols), length);
  else s.term.clearSelection();
  if (y < b.viewportY) s.term.scrollToLine(y);
  else if (y >= b.viewportY + s.term.rows) s.term.scrollToLine(y - s.term.rows + 1);
}

// ---------------------------------------------------------------- send to Claude & quick switcher

const tabOf = (id) => tabs.find((t) => tabSessionIds(t).includes(id));

// Goes to a pane wherever it is: its tab, out of the tray, focused.
function goToPane(id) {
  const t = tabOf(id);
  if (!t) return;
  switchTab(t);
  if (parked.includes(id)) unpark(id);
  if (zoomedId != null && zoomedId !== id) { zoomedId = id; render(); }
  setFocus(id, true);
  // A docked app can only take the keyboard once it's placed (next frame).
  if (sessions.get(id).kind === 'app') setTimeout(() => setFocus(id, true), 80);
}

// Claude panes text can be sent to, this tab's first. Docked CMD windows
// aren't included: they can't take a paste in one piece.
function claudeTargets(from) {
  const list = [];
  for (const t of tabs) {
    for (const id of tabSessionIds(t)) {
      const s = sessions.get(id);
      if (s === from || s.ptyId == null || s.exited || !(s.kind.startsWith('claude') || s.inClaude)) continue;
      list.push({ s, here: t === activeTab, label: t === activeTab ? `"${s.title}"` : `"${s.title}" (${t.name})` });
    }
  }
  return list.sort((a, b) => b.here - a.here).slice(0, 6);
}

// The selection lands in Claude's prompt as a paste (not sent yet), so you
// can add your question before pressing Enter.
function sendToClaude(from, to) {
  const text = from.psel ? promptSelText(from) : from.term.getSelection();
  from.term.clearSelection();
  from.psel = null;
  pasteToClaude(text, to);
}

function pasteToClaude(text, to) {
  if (!text || to.ptyId == null) return;
  // Without bracketed paste every line break would send the prompt; Alt+Enter
  // is a new line in Claude's prompt instead.
  const data = to.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, '\x1b\r');
  deck.write(to.ptyId, data);
  goToPane(to.id);
}

// Ctrl+Shift+P: every pane and tab, filtered as you type. (Plain Ctrl+P is
// left alone: Claude Code and shells use it for the previous history entry.)
function openSwitcher() {
  if (document.querySelector('.switcher')) return;
  const card = document.createElement('div');
  card.className = 'help-card switcher';
  card.innerHTML = '<input type="text" spellcheck="false" placeholder="Go to a pane or tab…" /><div class="sw-list"></div>';
  const input = card.querySelector('input');
  const list = card.querySelector('.sw-list');
  const entries = [];
  for (const t of tabs) {
    entries.push({ label: t.name, detail: 'tab', kind: 'tab', go: () => switchTab(t) });
    for (const id of tabSessionIds(t)) {
      const s = sessions.get(id);
      const where = [t.name, t.parked.includes(id) && 'parked', s.unsaved && 'unsaved', s.kind !== 'app' && s.cwd];
      entries.push({ label: s.title, detail: where.filter(Boolean).join(' · '), kind: s.kind, go: () => goToPane(id) });
    }
  }
  let shown = [];
  let at = 0;
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const q = words.join(' ');
    shown = entries
      .filter((e) => words.every((w) => `${e.label} ${e.detail}`.toLowerCase().includes(w)))
      .sort((a, b) => b.label.toLowerCase().startsWith(q) - a.label.toLowerCase().startsWith(q));
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((e, i) => {
      const row = document.createElement('div');
      row.className = 'sw-item' + (i === at ? ' on' : '');
      row.dataset.kind = e.kind;
      row.innerHTML = '<span class="dot"></span><span class="sw-label"></span><span class="sw-detail"></span>';
      row.children[1].textContent = e.label;
      row.children[2].textContent = e.detail;
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(e); });
      return row;
    }));
    list.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  let chosen = null;
  const close = modal(card, () => chosen?.go());
  const pick = (e) => { chosen = e; close(); };
  input.addEventListener('input', () => { at = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[at]) pick(shown[at]);
    }
  });
  draw();
  input.focus();
}

// ---------------------------------------------------------------- keyboard

const APP_KEYS = new Set(['N', 'T', 'D', 'W', 'P', 'ENTER']);
const isCycleKey = (e) => e.altKey && !e.ctrlKey && e.key.toUpperCase() === 'K';

function handleTermKey(s, e) {
  if (e.type !== 'keydown') return true;
  const key = e.key.toUpperCase();
  if (isCycleKey(e)) return false; // cycling panes, handled by the window
  if (e.ctrlKey && e.shiftKey && APP_KEYS.has(key)) return false; // let the window handle it
  if (e.altKey && e.shiftKey && !e.ctrlKey && key.startsWith('ARROW')) return false; // moving between panes
  if (e.ctrlKey && (key === 'TAB' || key === 'PAGEUP' || key === 'PAGEDOWN')) return false; // tab switching
  // Claude Code only acts on PageUp/PageDown in some views, so otherwise they'd
  // do nothing. Scroll the history ourselves, unless a full-screen app (alt
  // buffer) is running and wants the keys.
  if (!e.ctrlKey && !e.shiftKey && !e.altKey && (key === 'PAGEUP' || key === 'PAGEDOWN')) {
    const dir = key === 'PAGEUP' ? -1 : 1;
    if (s.hwnd) { deck.scrollWindow(s.hwnd, dir * Math.max(1, s.term.rows - 1)); return false; }
    if (s.term.buffer.active.type === 'normal') { s.term.scrollPages(dir); return false; }
  }
  if (e.shiftKey && !e.altKey && SELECT_KEYS.has(key)) {
    if (s.out) { selectInOutput(s, key, e.ctrlKey); return false; }
    if (key !== 'ARROWUP' && key !== 'ARROWDOWN' && selectInPrompt(s, key, e.ctrlKey)) return false;
    return true;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'A') {
    if (s.out) { s.term.selectAll(); return false; }
    return !selectAllPrompt(s);
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'X' && s.psel && s.term.hasSelection()) {
    deck.copy(promptSelText(s));
    sendKeys(s, typeOverSelection(s, '\x7f'));
    return false;
  }
  // Any other key (but a lone modifier) ends selecting in the output.
  if (!['SHIFT', 'CONTROL', 'ALT', 'META'].includes(key) && !(e.ctrlKey && key === 'C')) s.out = null;
  // Shift+Enter = new line in Claude's prompt (sent as Alt+Enter, which Claude understands).
  if (key === 'ENTER' && e.shiftKey && !e.ctrlKey && !e.altKey && (s.kind.startsWith('claude') || s.hwnd)) {
    if (s.ptyId != null) deck.write(s.ptyId, '\x1b\r');
    else if (s.hwnd) deck.writeWindow(s.hwnd, '\x1b\r');
    return false;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'C' && s.term.hasSelection()) {
    deck.copy(s.psel ? promptSelText(s) : s.term.getSelection());
    s.term.clearSelection();
    s.psel = null;
    return false;
  }
  if (e.ctrlKey && !e.altKey && key === 'V') return false; // browser fires a paste event xterm handles
  return true;
}

// Runs in the capture phase, before xterm (and so Claude) or the browser sees
// the key, so app shortcuts work whatever has focus. Claude Code's own keys
// (Tab, Shift+Tab, Esc, Ctrl+letter...) aren't app shortcuts and pass through.
window.addEventListener('keydown', (e) => {
  // Typing a tab or pane name.
  if (document.activeElement?.isContentEditable) return;
  // Tab in a terminal, editor or text box is its own.
  const inPane = !!document.activeElement?.closest('.xterm, .editor-pane, input, textarea, select');
  if (!appShortcut(e, inPane)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// Does what an app shortcut says; false if `e` isn't one. Also used for keys
// pressed in a browser pane's page (see browser.js).
function appShortcut(e, inPane = true) {
  const key = e.key.toUpperCase();
  if (isCycleKey(e)) {
    cyclePane(e.shiftKey ? -1 : 1);
  } else if (e.ctrlKey && !e.altKey && (key === 'TAB' || key === 'PAGEUP' || key === 'PAGEDOWN')) {
    cycleTab(key === 'PAGEUP' || (key === 'TAB' && e.shiftKey) ? -1 : 1);
  } else if (key === 'TAB' && !e.ctrlKey && !e.altKey && !inPane) {
    // No pane focused (e.g. an empty tab): Tab / Shift+Tab switch tabs instead
    // of walking focus through the toolbar buttons.
    cycleTab(e.shiftKey ? -1 : 1);
  } else if (e.ctrlKey && e.shiftKey && !e.altKey) {
    if (key === 'N') newSession('claude');
    else if (key === 'T') newTab();
    else if (key === 'D') newSession('cmd');
    else if (key === 'P') openSwitcher();
    else if (key === 'W' && focusedId != null) closeSession(focusedId);
    else if (key === 'ENTER' && focusedId != null) toggleZoom(focusedId);
    else return false;
  } else if (e.altKey && e.shiftKey && !e.ctrlKey && key.startsWith('ARROW')) {
    // Not Ctrl+Shift+arrows: those select a word at a time (see "keyboard selection").
    moveFocus(key.slice(5).toLowerCase());
  } else {
    return false;
  }
  return true;
}

// A clicked button would otherwise keep keyboard focus, so Space / Enter would
// press it again instead of going anywhere useful.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('button');
  if (btn) btn.blur();
}, true);

// Coming back to VibeCMD (or after a button took focus away), typing goes to
// the focused pane again, and its cursor shows as focused.
window.addEventListener('focus', () => {
  const s = sessions.get(focusedId);
  if (document.activeElement === document.body && s && s.kind !== 'app' && s.kind !== 'browser') focusPane(s);
});

function moveFocus(dir) {
  const cur = sessions.get(focusedId);
  if (!cur || zoomedId != null) return;
  const from = cur.el.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const id of leafIds(tree)) {
    if (id === focusedId) continue;
    const r = sessions.get(id).el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const ok = { left: dx < -1, right: dx > 1, up: dy < -1, down: dy > 1 }[dir];
    if (!ok) continue;
    const along = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  if (best != null) setFocus(best, true);
}

// ---------------------------------------------------------------- persistence

// Saved automatically on every change: all tabs, their layouts, and for each
// pane its kind, folder, title and Claude chat id. On the next launch every
// pane reopens in the same place, and Claude panes resume their own chat.
function save() {
  if (!activeTab) return;
  stashTab();
  const pane = (id) => {
    const s = sessions.get(id);
    return {
      type: 'leaf', kind: s.kind, cwd: s.cwd, title: s.title,
      claudeId: s.claudeId, fontSize: s.term.options.fontSize, color: s.color, renamed: s.renamed,
      app: s.app || undefined,
      uid: s.uid, link: s.link || undefined, linkEditor: s.linkEditor || undefined, run: s.run || undefined,
      ...(s.kind === 'editor' ? { ...editorState(s), wrap: s.wrap || undefined } : {}),
      url: s.url || undefined,
    };
  };
  // Docked CMD windows can't be reopened after a restart, so they're left out.
  // Docked apps are kept: they're started again with the same arguments.
  const saveable = (id) => sessions.get(id).kind !== 'docked';
  const ser = (node) => {
    if (!node) return null;
    if (node.type === 'leaf') return saveable(node.id) ? pane(node.id) : null;
    const children = node.children.map(ser);
    return {
      type: 'split', dir: node.dir,
      sizes: node.sizes.filter((_, i) => children[i]),
      children: children.filter(Boolean),
    };
  };
  const json = JSON.stringify({
    theme: themeName,
    cwd: defaultCwd,
    layouts,
    wheel: wheelCfg,
    active: tabs.indexOf(activeTab),
    tabs: tabs.map((t) => ({
      name: t.name, tree: ser(t.tree), parked: t.parked.filter(saveable).map(pane),
      // Which pane had focus / was maximized, as its position among the saved panes.
      focused: savedIndex(t, t.focusedId), zoomed: savedIndex(t, t.zoomedId),
    })),
  });
  if (json !== lastSaved) deck.saveState(json);
  lastSaved = json;
}

let lastSaved = null;

function savedIndex(t, id) {
  const ids = leafIds(t.tree).filter((x) => sessions.get(x).kind !== 'docked');
  const i = ids.indexOf(id);
  return i < 0 ? null : i;
}

function loadSaved() {
  // Older versions kept it in localStorage.
  try { return JSON.parse(deck.loadState() || localStorage.getItem('vibecmd.state')); } catch { return null; }
}

function restore(saved) {
  const open = (node) => {
    const s = createSession(node);
    // Reopened from last time: if its chat is gone, main.js falls back to the
    // folder's latest one rather than a blank chat.
    s.restored = true;
    const m = /^(.*) (\d+)$/.exec(node.title || '');
    if (m) counters[m[1]] = Math.max(counters[m[1]] || 0, +m[2]);
    return s.id;
  };
  const des = (node) => {
    if (!node) return null;
    if (node.type === 'leaf') return leaf(open(node));
    return split(node.dir, node.children.map(des), node.sizes);
  };
  tabs = (saved?.tabs || []).map((st) => {
    const t = makeTab(st.name);
    t.tree = normalize(des(st.tree));
    t.parked = (st.parked || []).map(open);
    const ids = leafIds(t.tree);
    t.focusedId = ids[st.focused ?? 0] ?? ids[0] ?? null;
    t.zoomedId = ids[st.zoomed] ?? null;
    return t;
  });
  if (!tabs.length) tabs.push(makeTab());
  loadTab(tabs[Math.max(0, Math.min(saved?.active ?? 0, tabs.length - 1))]);
}

// ---------------------------------------------------------------- toolbar

function showCwd() {
  $cwd.textContent = `📁 ${defaultCwd}`;
}

$cwd.addEventListener('click', async () => {
  const dir = await deck.pickFolder({ defaultPath: defaultCwd, title: 'Default folder for new sessions' });
  if (dir) rememberCwd(dir);
});

document.getElementById('even').addEventListener('click', () => {
  const even = (node) => {
    if (node?.type !== 'split') return;
    node.sizes = node.children.map(() => 1);
    node.children.forEach(even);
  };
  even(tree);
  render();
});

const $theme = document.getElementById('theme');
for (const name of Object.keys(THEMES)) $theme.add(new Option(name, name));
$theme.addEventListener('change', () => applyTheme($theme.value));

function applyTheme(name) {
  themeName = name;
  localStorage.setItem('vibecmd.theme', name);
  $theme.value = name;
  const t = THEMES[name];
  setThemeBg(t.term.background);
  for (const [k, v] of Object.entries(t.ui)) document.documentElement.style.setProperty(`--${k}`, v);
  for (const s of sessions.values()) s.term.options.theme = t.term;
  setEditorTheme();
  $theme.blur();
  save();
}
applyTheme(themeName);

// Help: one page per section, picked with the tabs along its top.
const $help = document.getElementById('help');
const helpTabs = [...$help.querySelectorAll('.help-tabs button')];
const helpPages = [...$help.querySelectorAll('.help-page')];

function showHelpPage(i) {
  helpTabs.forEach((b, j) => b.classList.toggle('on', i === j));
  helpPages.forEach((p, j) => { p.hidden = i !== j; });
  $help.querySelector('.help-body').scrollTop = 0;
}

helpTabs.forEach((b, i) => b.addEventListener('click', () => showHelpPage(i)));
showHelpPage(0);
// Checks GitHub for a newer release. When one exists the button turns into a link to it.
const $update = document.getElementById('update');
let updateUrl = null;
$update.addEventListener('click', async () => {
  if (updateUrl) { deck.openExternal(updateUrl); return; }
  $update.disabled = true;
  $update.textContent = 'Checking…';
  const r = await deck.checkUpdate();
  $update.disabled = false;
  if (r.error) {
    $update.textContent = 'Check failed, retry';
    $update.title = r.error;
  } else if (r.newer) {
    updateUrl = r.url;
    $update.textContent = `${r.latest} available, download`;
    $update.title = `You have v${r.current}. Click to open the download page.`;
  } else {
    $update.textContent = `Up to date (v${r.current})`;
    setTimeout(() => { $update.textContent = 'Check updates'; }, 3000);
  }
});

document.getElementById('help-btn').addEventListener('click', () => { $help.hidden = false; });
document.getElementById('help-close').addEventListener('click', () => { $help.hidden = true; });
$help.addEventListener('mousedown', (e) => { if (e.target === $help) $help.hidden = true; });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$help.hidden) { e.stopPropagation(); $help.hidden = true; }
}, true);
// Docked app windows would sit on top of it.
new MutationObserver(syncApps).observe($help, { attributes: true, attributeFilter: ['hidden'] });

(async () => {
  const saved = loadSaved();
  if (saved?.theme in THEMES) applyTheme(saved.theme);
  layouts = saved?.layouts || [];
  nextLayoutId = Math.max(0, ...layouts.map((l) => l.id)) + 1;
  wheelCfg = { ...DEFAULT_WHEEL, ...saved?.wheel };
  defaultCwd = saved?.cwd || localStorage.getItem('deck.cwd') || (await deck.homedir());
  showCwd();
  restore(saved);
  render();
})();
