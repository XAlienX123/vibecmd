const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, clipboard, Menu, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const pty = require('node-pty');

const IS_WIN = process.platform === 'win32';

// Must match the Start-menu shortcut made by scripts/install.js so Windows
// groups the running window with that shortcut's icon on the taskbar.
app.setName('VibeCMD');
if (IS_WIN) app.setAppUserModelId('VibeCMD');

// Two copies would overwrite each other's saved tabs, so a second launch just
// brings the existing window to the front.
if (!app.requestSingleInstanceLock()) app.exit(0);

const ptys = new Map();
let nextId = 1;
let win;

// What each session type actually launches. Claude runs inside cmd /k so that
// when you exit Claude you're left at a normal prompt instead of a dead pane.
// PowerShell gets a prompt that reports its folder the same way cmd's does
// (OSC 9;9, see pty:create), wrapped around whatever prompt the profile set up.
const PS_PROMPT = [
  '$__vibePrompt = $function:prompt',
  'function prompt { $p = & $__vibePrompt; "$([char]27)]9;9;$($executionContext.SessionState.Path.CurrentLocation.ProviderPath)$([char]27)\\$p" }',
].join('\n');

const KINDS = {
  claude: { file: 'cmd.exe', args: ['/k', 'claude'] },
  'claude-continue': { file: 'cmd.exe', args: ['/k', 'claude --continue'] },
  cmd: { file: 'cmd.exe', args: [] },
  powershell: {
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(PS_PROMPT, 'utf16le').toString('base64')],
  },
};

// ---------------------------------------------------------------- linux shells

// On Linux the "CMD" kind is the user's own shell, and a Claude pane is that
// shell with the claude command typed into it, so exiting Claude leaves a
// normal prompt (like cmd /k). The shell is set up to report its folder the
// same way cmd does (OSC 9;9) by a small rc file that wraps the user's own.
const userShell = () => process.env.SHELL || '/bin/bash';
const shellDir = () => path.join(app.getPath('userData'), 'shell');

// VIBECMD_RUN is the command a Claude pane starts with; it's run once the
// user's rc has loaded and kept in history, as if typed at the prompt.
const BASH_RC = String.raw`[ -f ~/.bashrc ] && . ~/.bashrc
__vibe_cwd() { printf '\e]9;9;%s\e\\' "$PWD"; }
PROMPT_COMMAND="__vibe_cwd${'$'}{PROMPT_COMMAND:+;$PROMPT_COMMAND}"
if [ -n "$VIBECMD_RUN" ]; then __vibe_run=$VIBECMD_RUN; unset VIBECMD_RUN; history -s "$__vibe_run"; eval "$__vibe_run"; fi
`;
// zsh reads its rc files from ZDOTDIR, so point that here and hand over to the
// user's own files (from their real ZDOTDIR) from inside ours.
const ZSH_ENV = String.raw`ZDOTDIR=${'$'}{VIBECMD_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
VIBECMD_ZDOTDIR=$ZDOTDIR
ZDOTDIR=${'$'}{VIBECMD_SHELL_DIR}
`;
const ZSH_RC = String.raw`ZDOTDIR=$VIBECMD_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc
__vibe_cwd() { printf '\e]9;9;%s\e\\' "$PWD" }
autoload -Uz add-zsh-hook
add-zsh-hook precmd __vibe_cwd
if [[ -n $VIBECMD_RUN ]]; then __vibe_run=$VIBECMD_RUN; unset VIBECMD_RUN; print -s -- "$__vibe_run"; eval "$__vibe_run"; fi
`;
const FISH_INIT = String.raw`function __vibe_cwd --on-event fish_prompt; printf '\e]9;9;%s\e\\\\' $PWD; end
if set -q VIBECMD_RUN; set -l c $VIBECMD_RUN; set -e VIBECMD_RUN; eval $c; end`;

function setUpShells() {
  fs.mkdirSync(shellDir(), { recursive: true });
  fs.writeFileSync(path.join(shellDir(), 'bashrc'), BASH_RC);
  fs.writeFileSync(path.join(shellDir(), '.zshenv'), ZSH_ENV);
  fs.writeFileSync(path.join(shellDir(), '.zshrc'), ZSH_RC);
}

// The user's shell, interactive, with the folder reporting added. Extra
// environment it needs is returned in `env`.
function shellSpec(file = userShell()) {
  const name = path.basename(file);
  if (name === 'bash') return { file, args: ['--rcfile', path.join(shellDir(), 'bashrc'), '-i'], wrapped: true };
  if (name === 'fish') return { file, args: ['--init-command', FISH_INIT], wrapped: true };
  if (name === 'zsh') {
    return {
      file,
      args: ['-i'],
      wrapped: true,
      env: { ZDOTDIR: shellDir(), VIBECMD_SHELL_DIR: shellDir(), VIBECMD_ZDOTDIR: process.env.ZDOTDIR || '' },
    };
  }
  return { file, args: ['-i'] };
}

function onPath(name) {
  return (process.env.PATH || '').split(':').some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function linuxKind(kind) {
  if (kind === 'powershell' && onPath('pwsh')) return { file: 'pwsh', args: ['-NoLogo', '-NoExit', '-Command', PS_PROMPT] };
  return shellSpec();
}

// Markers a running Claude Code session puts in its children's environment. If
// VibeCMD is launched from inside Claude, these would make every new session
// think it's a sub-session of that one.
const INHERITED_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

function sessionEnv() {
  const env = { ...process.env, COLORTERM: 'truecolor' };
  for (const key of INHERITED_SESSION_VARS) delete env[key];
  return env;
}

// ---------------------------------------------------------------- window

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
  } catch {
    return { width: 1600, height: 950 };
  }
}

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    backgroundColor: '#16161e',
    title: 'VibeCMD',
    icon: path.join(__dirname, 'build', IS_WIN ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (bounds.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // A fresh page means any old terminals have nothing showing them any more.
  win.webContents.on('did-start-loading', () => {
    for (const proc of ptys.values()) killTree(proc);
    ptys.clear();
    dockedBusy.clear();
    Promise.all([...mirrors.keys()].map(stopMirror)).then(() => helperSend('release-all'));
    for (const id of [...browsers.keys()]) destroyBrowser(id);
    for (const file of watched.keys()) fs.unwatchFile(file);
    watched.clear();
    unsavedFiles = 0;
  });

  let confirmed = false;
  let released = false;
  let appsClosed = false;
  let closingApps = false;
  let filesSettled = false;
  let savingFiles = false;
  win.on('close', (e) => {
    if (closingApps || savingFiles) { e.preventDefault(); return; }
    // Idle sessions just reopen next time, so only ask when something is still
    // running: Claude mid-task, or a command that hasn't returned to the prompt.
    const busy = [...ptys.values()].filter(isBusy).length + dockedBusy.size;
    if (busy && !confirmed) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Quit VibeCMD?',
        message: `${busy} session${busy > 1 ? 's are' : ' is'} still working (Claude mid-task or a command still running).`,
        detail: 'Quitting stops that work. Your tabs, layout and Claude chats are saved and reopen next time.',
      });
      if (choice === 1) { e.preventDefault(); return; }
      confirmed = true;
    }
    // Files with unsaved changes in editor panes: save them, or not, or stay.
    if (unsavedFiles && !filesSettled) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Save all', "Don't save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Quit VibeCMD?',
        message: `${unsavedFiles} file${unsavedFiles > 1 ? 's have' : ' has'} unsaved changes in editor panes.`,
      });
      if (choice === 2) { confirmed = false; return; }
      if (choice === 1) { filesSettled = true; win.close(); return; }
      savingFiles = true;
      saveAllFiles().then((ok) => {
        savingFiles = false;
        if (!win) return;
        if (!ok) { confirmed = false; return; }
        filesSettled = true;
        win.close();
      });
      return;
    }
    // Docked apps (editors) are asked to close next, one by one, so each can
    // offer to save. Cancel in any of them and VibeCMD stays open as it was:
    // apps that did close are started again in their panes (see app:quitting).
    if (helper && !appsClosed) {
      e.preventDefault();
      closingApps = true;
      win.webContents.send('app:quitting', true);
      helperRequest('close-apps', 'close-apps', 0).then((ok) => {
        closingApps = false;
        if (!win) return;
        if (!ok) {
          confirmed = false;
          filesSettled = false;
          win.webContents.send('app:quitting', false);
          return;
        }
        appsClosed = true;
        win.close();
      });
      return;
    }
    try {
      fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch { /* not important */ }
    // Docked CMD windows are hidden, so close them along with VibeCMD rather
    // than leave them running where you can't see them.
    if (helper && !released) {
      e.preventDefault();
      stopMirrors();
      helperRequest('close-all', 'closed-all').then(() => {
        released = true;
        win?.close();
      });
    }
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// ---------------------------------------------------------------- claude sessions

// Claude stores each chat as projects/<folder>/<session id>.jsonl.
const projectsRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

function chatExists(sessionId) {
  try {
    return fs.readdirSync(projectsRoot()).some((dir) => fs.existsSync(path.join(projectsRoot(), dir, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

// The most recently used chat in a folder that no other pane has open. Used
// when a reopened pane's own chat can't be found (e.g. the pane was started by
// an older VibeCMD that didn't track chat ids), so it picks up where that
// folder left off instead of starting blank. Claude names the folder after the
// path with every non-alphanumeric character turned into "-".
function latestChatIn(cwd) {
  const dir = path.join(projectsRoot(), (cwd || '').replace(/[^a-zA-Z0-9]/g, '-'));
  const taken = new Set([...ptys.values()].map((p) => p.claudeId));
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && UUID.test(f.slice(0, -6)) && !taken.has(f.slice(0, -6)))
      .map((f) => ({ id: f.slice(0, -6), at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.id ?? null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude panes get an extra SessionStart hook (scripts/session-hook.js) that
// reports the pane's current chat id on startup, /resume and /clear. Each pane
// gets its own report file, named by its pty id.
const sessionsDir = () => path.join(app.getPath('userData'), 'sessions');
const hookSettingsFile = () => path.join(app.getPath('userData'), 'claude-hook-settings.json');

function setUpSessionTracking() {
  fs.rmSync(sessionsDir(), { recursive: true, force: true });
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const hook = path.join(__dirname, 'scripts', 'session-hook.js').replace(/\\/g, '/');
  // Linux installs of Claude often come without node, so run the hook with
  // VibeCMD's own Electron in node mode instead.
  const command = IS_WIN ? `node "${hook}"` : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${hook}"`;
  const entry = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  // Files Claude edits, for panes linked to an editor (see "linked editors" in app.js).
  const edits = [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command, timeout: 10 }] }];
  fs.writeFileSync(hookSettingsFile(), JSON.stringify({
    hooks: { SessionStart: entry, UserPromptSubmit: entry, Stop: entry, PostToolUse: edits },
  }, null, 2));

  fs.watch(sessionsDir(), (_event, file) => {
    const m = /^(\d+)\.json$/.exec(file || '');
    const proc = m && ptys.get(+m[1]);
    if (!proc) return;
    try {
      const { sessionId, busy, edited, at } = JSON.parse(fs.readFileSync(path.join(sessionsDir(), file), 'utf8'));
      if (!UUID.test(sessionId)) return;
      proc.claudeId = sessionId;
      win?.webContents.send('pty:claudeSession', +m[1], sessionId);
      // The watcher fires more than once per write; report each edit once.
      if (edited && at !== proc.editedAt) {
        proc.editedAt = at;
        win?.webContents.send('pty:edited', +m[1], edited);
      }
      setBusy(+m[1], proc, !!busy);
    } catch { /* mid-rename; the next event will have it */ }
  });
}

// "Busy" = Claude is mid-task, so closing would interrupt it. Sources: the
// hooks above, Claude's window title (◐/◑ spinner while working, ✳ when idle;
// the only signal after an Esc interrupt) and cmd's prompt coming back.
function setBusy(id, proc, busy) {
  if (proc.claudeBusy === busy) return;
  proc.claudeBusy = busy;
  reportBusy(id, proc);
}

// CMD / PowerShell panes count as busy from the moment Enter is pressed until
// the shell's prompt (which reports its folder, OSC 9;9) comes back, i.e.
// while a command is running.
const isBusy = (proc) => !!(proc.claudeBusy || proc.commandRunning);

function reportBusy(id, proc) {
  const busy = isBusy(proc);
  if (proc.reportedBusy === busy) return;
  proc.reportedBusy = busy;
  win?.webContents.send('pty:busy', id, busy);
}

function watchBusy(id, proc, data) {
  // Claude's title is also seen when it's started by hand in a CMD pane; while
  // it runs, its own working/idle state is what counts, not the shell's.
  for (const m of data.matchAll(/\x1b\]0;(.)/gu)) {
    if (m[1] !== '✳' && !'◐◑◒◓'.includes(m[1])) continue;
    proc.inClaude = true;
    proc.commandRunning = false;
    setBusy(id, proc, m[1] !== '✳');
  }
  if (data.includes('\x1b]9;9;')) {
    proc.inClaude = false;
    proc.commandRunning = false;
    setBusy(id, proc, false);
    reportBusy(id, proc);
  }
}

// Enter at a shell prompt starts a command. Inside Claude it doesn't; there
// the hooks and title above decide. A Claude pane starts out inside Claude.
function watchInput(id, proc, data) {
  if (!data.includes('\r') || proc.commandRunning || proc.inClaude) return;
  proc.commandRunning = true;
  reportBusy(id, proc);
}

// Each Claude pane remembers its chat id, so after a restart it reopens exactly
// its own chat instead of whichever one in that folder was used last.
function commandFor(kind, sessionId, cwd, restored) {
  let command;
  if (kind === 'claude' && UUID.test(sessionId || '')) {
    const fallback = restored && !chatExists(sessionId) && latestChatIn(cwd);
    if (fallback) sessionId = fallback;
    command = `claude ${fallback || chatExists(sessionId) ? '--resume' : '--session-id'} ${sessionId}`;
  } else if (kind.startsWith('claude')) {
    command = KINDS[kind].args[1];
  } else {
    if (!IS_WIN) return linuxKind(kind);
    return KINDS[kind] || KINDS.cmd;
  }
  command += ` --settings "${hookSettingsFile()}"`;
  if (!IS_WIN) {
    const spec = shellSpec();
    // Shells without the rc wrapper get the command typed in instead.
    if (!spec.wrapped) return { ...spec, typeIn: command, claudeId: sessionId };
    return { ...spec, env: { ...spec.env, VIBECMD_RUN: command }, claudeId: sessionId };
  }
  // A single string is passed to Windows as-is; as an array, node-pty would
  // escape the quotes and Claude would get them as part of the path.
  return { file: 'cmd.exe', args: `/k ${command}`, claudeId: sessionId };
}

// ---------------------------------------------------------------- docking outside CMD windows

// native/winhelper.cs does the Win32 work: it notices when a CMD window is
// dragged over VibeCMD, hides it while it's docked, and gives it back later.
// A second copy per docked window ("mirror") streams that console's screen
// into its pane and types keys back into it. It's compiled with the C#
// compiler that ships with Windows on first use.
const HELPER_SRC = path.join(__dirname, 'native', 'winhelper.cs');
const HELPER_EXE = path.join(__dirname, 'build', 'winhelper.exe');
let helper = null;
const helperWaiters = new Map();
const mirrors = new Map();
// Docked windows running a busy Claude (the renderer reads it from their title).
const dockedBusy = new Set();

function buildHelper() {
  try {
    if (fs.statSync(HELPER_EXE).mtimeMs >= fs.statSync(HELPER_SRC).mtimeMs) return true;
  } catch { /* not built yet */ }
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  fs.mkdirSync(path.dirname(HELPER_EXE), { recursive: true });
  const res = spawnSync(csc, ['-nologo', '-optimize', '-platform:x64', '-r:System.Management.dll', `-out:${HELPER_EXE}`, HELPER_SRC], { windowsHide: true, encoding: 'utf8' });
  if (res.status !== 0) console.error('winhelper build failed:', res.stdout || res.error);
  return res.status === 0;
}

function startHelper() {
  if (!buildHelper()) return;
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  helper = require('child_process').spawn(HELPER_EXE, [hwnd], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  helper.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      onHelperLine(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
  });
  helper.on('exit', () => {
    helper = null;
    for (const done of helperWaiters.values()) done(null);
    helperWaiters.clear();
  });
}

// Linux: on X11 (or with VibeCMD on XWayland) needs xdotool and xprop; under
// Wayland needs KDE Plasma 6, whose KWin does the moving. Without them docking
// isn't offered.
let linuxDock = null;
let linuxWindows = null;

// Resolves once the helper is up (or known not to be), so saved apps that
// restart with the window don't ask too early.
let helperReady = Promise.resolve();

// Electron runs as a native Wayland app under Wayland, unless told to use X11.
function onWayland() {
  const forced = app.commandLine.getSwitchValue('ozone-platform') || app.commandLine.getSwitchValue('ozone-platform-hint')
    || process.env.ELECTRON_OZONE_PLATFORM_HINT;
  return !!process.env.WAYLAND_DISPLAY && forced !== 'x11';
}

function startLinuxDock() {
  if (process.platform !== 'linux') return;
  helperReady = (async () => {
    if (onWayland()) {
      linuxDock = await require('./kwindock').createKwinDock({ emit: onHelperLine, dir: app.getPath('userData') });
      if (!linuxDock) return;
      linuxWindows = linuxDock.list;
    } else {
      const dock = require('./linuxdock');
      if (!await dock.available()) return;
      const self = win.getNativeWindowHandle().readUInt32LE(0);
      linuxWindows = () => dock.listWindows(self);
      const origin = () => {
        const c = win.getContentBounds();
        const sf = screen.getDisplayMatching(win.getBounds()).scaleFactor;
        return { x: c.x * sf, y: c.y * sf, w: c.width * sf, h: c.height * sf };
      };
      linuxDock = dock.createLinuxDock({ emit: onHelperLine, origin, self });
    }
    helper = { stdin: { write: (line) => linuxDock.command(line.trim()) } };
    for (const ev of ['move', 'resize']) win.on(ev, () => linuxDock.reposition());
    app.on('will-quit', () => linuxDock?.dispose());
  })();
}

ipcMain.handle('docked:windows', async () => {
  await helperReady;
  if (linuxWindows) return linuxWindows();
  return IS_WIN ? helperRequest('list', 'windows', 5000) : null;
});

function helperSend(line) {
  helper?.stdin.write(`${line}\n`);
}

// `timeout` 0: wait as long as it takes (an app's save question can stay open).
function helperRequest(line, reply, timeout = 3000) {
  return new Promise((resolve) => {
    if (!helper) { resolve(null); return; }
    helperWaiters.set(reply, resolve);
    helperSend(line);
    if (timeout) setTimeout(() => { if (helperWaiters.delete(reply)) resolve(null); }, timeout);
  });
}

function answerHelper(reply, value) {
  helperWaiters.get(reply)?.(value);
  helperWaiters.delete(reply);
}

function onHelperLine(line) {
  const [kind, hwnd, ...rest] = line.split(' ');
  if (kind === 'drag-move' || kind === 'drag-end') {
    const [sx, sy, over] = rest.map(Number);
    const content = win.getContentBounds();
    const dip = screen.screenToDipPoint({ x: sx, y: sy });
    const s = win.webContents.getZoomFactor();
    win.webContents.send('xdrag', kind === 'drag-end' ? 'end' : 'move', hwnd,
      (dip.x - content.x) / s, (dip.y - content.y) / s, over === 1);
  } else if (kind === 'embedded') {
    answerHelper(`embed ${hwnd}`, JSON.parse(Buffer.from(rest[0], 'base64').toString('utf8')));
  } else if (kind === 'error') {
    answerHelper(`embed ${hwnd}`, null);
  } else if (kind === 'windows') {
    answerHelper('windows', JSON.parse(Buffer.from(rest[0], 'base64').toString('utf8')));
  } else if (kind === 'launch') {
    answerHelper(`launch ${hwnd}`, rest[0] === '0' ? null : rest[0]);
  } else if (kind === 'close-app') {
    answerHelper(`close-app ${hwnd}`, rest[0] === '1');
  } else if (kind === 'released-all' || kind === 'closed-all') {
    answerHelper(kind, true);
  } else if (kind === 'closed-apps' || kind === 'apps-kept') {
    answerHelper('close-apps', kind === 'closed-apps');
  } else if (kind === 'gone' || kind === 'title' || kind === 'focus' || kind === 'reveal') {
    win?.webContents.send(`docked:${kind}`, hwnd, rest.join(' '));
  }
}

function startMirror(hwnd) {
  const m = require('child_process').spawn(HELPER_EXE, ['mirror', hwnd], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  m.stdout.setEncoding('utf8');
  m.stdout.on('data', (d) => win?.webContents.send('docked:data', hwnd, d));
  m.stdin.on('error', () => {});
  m.on('exit', () => mirrors.delete(hwnd));
  mirrors.set(hwnd, m);
}

function stopMirrors() {
  for (const m of mirrors.values()) m.stdin.end();
  mirrors.clear();
}

// Resolves once the mirror has exited, so the window has its own font back
// before it's shown again.
function stopMirror(hwnd) {
  const m = mirrors.get(hwnd);
  mirrors.delete(hwnd);
  if (!m || m.exitCode !== null) return Promise.resolve();
  m.stdin.end();
  return new Promise((done) => { m.once('exit', done); setTimeout(done, 1000); });
}

const mirrorSend = (hwnd, line) => mirrors.get(hwnd)?.stdin.write(`${line}\n`);

ipcMain.handle('docked:embed', async (_e, hwnd) => {
  await helperReady;
  // Reading an app's command line (to reopen it next time) can take a moment.
  const res = await helperRequest(`embed ${hwnd}`, `embed ${hwnd}`, 10000);
  // App windows show themselves; only consoles are mirrored.
  if (res && !res.app && !mirrors.has(hwnd)) startMirror(hwnd);
  return res;
});

// Docked app windows (editors and the like) sit over their pane for real; the
// renderer tells where (in its own pixels, turned into the window's here).
// KWin works in logical pixels, from the top left of the window's client area;
// if Electron draws its own title bar there, the page starts below it.
ipcMain.on('app:place', (_e, hwnd, x, y, w, h) => {
  if (linuxDock?.logical) {
    const z = win.webContents.getZoomFactor();
    const c = win.getContentBounds();
    const b = win.getBounds();
    helperSend(`place ${hwnd} ${Math.round(x * z + c.x - b.x)} ${Math.round(y * z + c.y - b.y)} ${Math.round(w * z)} ${Math.round(h * z)}`);
    return;
  }
  const s = win.webContents.getZoomFactor() * screen.getDisplayMatching(win.getBounds()).scaleFactor;
  const px = (v) => Math.round(v * s);
  helperSend(`place ${hwnd} ${px(x)} ${px(y)} ${px(w)} ${px(h)}`);
});
ipcMain.on('app:hide', (_e, hwnd) => helperSend(`hide ${hwnd}`));
ipcMain.on('app:focus', (_e, hwnd) => helperSend(`focus ${hwnd}`));
// Resolves false if the app stayed open (its save question was cancelled).
ipcMain.handle('app:close', (_e, hwnd) => helperRequest(`close-app ${hwnd}`, `close-app ${hwnd}`, 0));
// Starts a saved app again; resolves with its window, or null.
let nextLaunch = 1;
ipcMain.handle('app:launch', async (_e, { exe, args }) => {
  if (!exe) return null;
  await helperReady;
  const id = nextLaunch++;
  const spec = Buffer.from(JSON.stringify({ exe, args: args || '' })).toString('base64');
  return helperRequest(`launch ${id} ${spec}`, `launch ${id}`, 20000);
});
ipcMain.on('docked:write', (_e, hwnd, data) => mirrorSend(hwnd, `w ${Buffer.from(data).toString('base64')}`));
ipcMain.on('docked:resize', (_e, hwnd, cols, rows) => mirrorSend(hwnd, `r ${cols} ${rows}`));
ipcMain.on('docked:scroll', (_e, hwnd, lines) => mirrorSend(hwnd, `s ${lines}`));
ipcMain.on('docked:release', (_e, hwnd) => {
  dockedBusy.delete(hwnd);
  stopMirror(hwnd).then(() => helperSend(`release ${hwnd}`));
});
// Closing a docked pane closes its window too, instead of handing it back.
ipcMain.on('docked:close', (_e, hwnd) => {
  mirrors.get(hwnd)?.stdin.end();
  mirrors.delete(hwnd);
  dockedBusy.delete(hwnd);
  helperSend(`close ${hwnd}`);
});
ipcMain.on('docked:busy', (_e, hwnd, busy) => {
  if (busy) dockedBusy.add(hwnd);
  else dockedBusy.delete(hwnd);
});

// ---------------------------------------------------------------- terminals

ipcMain.handle('pty:create', (_e, { kind, cwd, cols, rows, sessionId, restored }) => {
  const spec = commandFor(kind, sessionId, cwd, restored);
  const id = nextId++;
  const env = { ...sessionEnv(), ...spec.env };
  // Makes cmd report its current folder (OSC 9;9, same trick Windows Terminal
  // uses) so a CMD pane reopens wherever you last cd'd to.
  if (IS_WIN) env.PROMPT = `$e]9;9;$P$e\\${env.PROMPT || '$P$G'}`;
  env.VIBECMD_SESSION_FILE = path.join(sessionsDir(), `${id}.json`);
  const proc = pty.spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    env,
    useConpty: true,
    // The ConPTY built into Windows 10 handles resizes badly (full-screen apps
    // like Claude don't redraw to the new size); use node-pty's current copy.
    useConptyDll: true,
  });
  proc.vibeKind = kind;
  proc.claudeId = spec.claudeId;
  proc.inClaude = kind.startsWith('claude');
  ptys.set(id, proc);
  // The shell reads this once it's at its first prompt.
  if (spec.typeIn) proc.write(`${spec.typeIn}\r`);
  proc.onData((data) => {
    watchBusy(id, proc, data);
    win?.webContents.send('pty:data', id, data);
  });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    fs.rm(env.VIBECMD_SESSION_FILE, { force: true }, () => {});
    win?.webContents.send('pty:exit', id, exitCode);
  });
  return id;
});

ipcMain.on('pty:write', (_e, id, data) => {
  const proc = ptys.get(id);
  if (!proc) return;
  watchInput(id, proc, data);
  proc.write(data);
});

ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try { ptys.get(id)?.resize(cols, rows); } catch { /* process already gone */ }
});

// node-pty's own kill() relies on a helper that fails under Electron and can
// leave e.g. claude.exe running inside the shell, so take down the whole tree.
function killTree(proc, sync = false) {
  // On Linux the pty's shell leads its own session; hang up everything in it
  // (SIGHUP, as when a terminal window closes).
  if (!IS_WIN) {
    const args = ['-HUP', '-s', String(proc.pid)];
    if (sync) spawnSync('pkill', args, { stdio: 'ignore' });
    else execFile('pkill', args, () => {});
    return;
  }
  const args = ['/pid', String(proc.pid), '/T', '/F'];
  const opts = { windowsHide: true, stdio: 'ignore' };
  if (sync) spawnSync('taskkill.exe', args, opts);
  else execFile('taskkill.exe', args, opts, () => {});
}

ipcMain.on('pty:kill', (_e, id) => {
  const proc = ptys.get(id);
  if (!proc) return;
  ptys.delete(id);
  killTree(proc);
});

// Pop a pane out as a normal console window: its process is stopped and the
// same thing is started in a real window (a Claude pane resumes its own chat).
// Dragging that window back onto VibeCMD docks it again.
ipcMain.handle('pane:popOut', (_e, opts) => (IS_WIN ? popOutWindows(opts) : popOutLinux(opts)));

// Terminal emulators to pop out into, most likely first, and how each is
// told the folder and the command to run.
const TERMINALS = [
  ['konsole', (dir) => ['--workdir', dir, '-e']],
  ['gnome-terminal', (dir) => [`--working-directory=${dir}`, '--']],
  ['kitty', (dir) => ['--directory', dir]],
  ['alacritty', (dir) => ['--working-directory', dir, '-e']],
  ['wezterm', (dir) => ['start', '--cwd', dir, '--']],
  ['ghostty', () => ['-e']],
  ['foot', (dir) => ['-D', dir]],
  ['xfce4-terminal', (dir) => [`--working-directory=${dir}`, '-x']],
  ['x-terminal-emulator', () => ['-e']],
  ['xterm', () => ['-e']],
];

function popOutLinux({ ptyId, kind, cwd, claudeId }) {
  const term = TERMINALS.find(([name]) => onPath(name));
  if (!term) return false;
  const proc = ptys.get(ptyId);
  if (proc) {
    ptys.delete(ptyId);
    killTree(proc, true);
  }
  let program = '';
  if (kind === 'claude-continue') program = 'claude --continue; ';
  else if (kind === 'claude') {
    const flag = UUID.test(claudeId || '') ? `${chatExists(claudeId) ? '--resume' : '--session-id'} ${claudeId}` : '';
    program = `claude ${flag}; `;
  }
  const shell = kind === 'powershell' && onPath('pwsh') ? 'pwsh' : userShell();
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const [file, flags] = term;
  require('child_process').spawn(file, [...flags(dir), 'sh', '-c', `${program}exec "${shell}"`], {
    cwd: dir, env: sessionEnv(), detached: true, stdio: 'ignore',
  }).unref();
  return true;
}

function popOutWindows({ ptyId, kind, cwd, claudeId, title }) {
  const proc = ptys.get(ptyId);
  if (proc) {
    ptys.delete(ptyId);
    killTree(proc, true);
  }
  let program = 'cmd.exe';
  if (kind === 'claude-continue') program = 'cmd.exe /k claude --continue';
  else if (kind === 'claude') {
    const flag = UUID.test(claudeId || '') ? `${chatExists(claudeId) ? '--resume' : '--session-id'} ${claudeId}` : '';
    program = `cmd.exe /k claude ${flag}`;
  } else if (kind === 'powershell') program = 'powershell.exe -NoLogo -NoExit';
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const name = String(title || 'VibeCMD').replace(/["&|<>^%]/g, '');
  require('child_process').spawn('cmd.exe', ['/d', '/s', '/c', `"start "${name}" /D "${dir}" ${program}"`], {
    env: sessionEnv(), detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  }).unref();
  return true;
}

// ---------------------------------------------------------------- saved layout

// Tabs, layouts and panes (see save() in renderer/app.js). Kept in a file and
// written straight away, so it survives VibeCMD being killed or crashing,
// which localStorage (flushed lazily) doesn't.
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

ipcMain.on('state:load', (e) => {
  try {
    e.returnValue = fs.readFileSync(stateFile(), 'utf8');
  } catch {
    e.returnValue = null;
  }
});

ipcMain.on('state:save', (_e, json) => {
  try {
    fs.writeFileSync(`${stateFile()}.tmp`, json);
    fs.renameSync(`${stateFile()}.tmp`, stateFile());
  } catch { /* try again on the next change */ }
});

// ---------------------------------------------------------------- misc

ipcMain.handle('dialog:pickFile', async (_e, { defaultPath, title, buttonLabel, filters } = {}) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath, title, buttonLabel, filters });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_e, { defaultPath, title } = {}) => {
  const res = await dialog.showSaveDialog(win, { defaultPath, title });
  return res.canceled ? null : res.filePath;
});

// 0 save, 1 don't save, 2 cancel.
ipcMain.handle('dialog:unsaved', async (_e, { message, detail }) => {
  const res = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2, title: 'Unsaved changes', message, detail,
  });
  return res.response;
});

// ---------------------------------------------------------------- editor panes' files

// Files are read as UTF-8 (with or without a BOM) or UTF-16 LE with a BOM.
// Anything else is taken byte for byte as Latin-1, so saving it writes back
// exactly the bytes it had.
const MAX_EDIT_SIZE = 50 * 1024 * 1024;

ipcMain.handle('file:read', (_e, file) => {
  try {
    if (fs.statSync(file).size > MAX_EDIT_SIZE) return { error: 'This file is too big to edit here (over 50 MB).' };
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true };
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const body = bom ? buf.subarray(3) : buf;
    if (body.subarray(0, 8000).includes(0)) return { error: 'This looks like a binary file, not text.' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf8', bom };
    } catch {
      return { text: body.toString('latin1'), encoding: 'latin1', bom: false };
    }
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'The file no longer exists.' : err.message };
  }
});

ipcMain.handle('file:write', (_e, file, text, { encoding = 'utf8', bom = false } = {}) => {
  try {
    // U+FEFF comes out as the right BOM for either encoding.
    fs.writeFileSync(file, (bom ? '﻿' : '') + text, encoding);
    return null;
  } catch (err) {
    return err.message;
  }
});

// Open files are polled for changes made outside (Claude's edits, say). Polling
// also survives editors that save by replacing the file, which fs.watch doesn't.
const watched = new Map();

ipcMain.on('file:watch', (_e, file) => {
  const n = watched.get(file) || 0;
  watched.set(file, n + 1);
  if (n) return;
  fs.watchFile(file, { interval: 700 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) win?.webContents.send('file:changed', file);
  });
});

ipcMain.on('file:unwatch', (_e, file) => {
  const n = (watched.get(file) || 0) - 1;
  if (n > 0) { watched.set(file, n); return; }
  watched.delete(file);
  fs.unwatchFile(file);
});

// How many files in editor panes have unsaved changes; quitting asks about them.
let unsavedFiles = 0;
ipcMain.on('editor:unsaved', (_e, n) => { unsavedFiles = n; });

// Resolves true once the renderer has saved every file (false: one wasn't).
function saveAllFiles() {
  return new Promise((resolve) => {
    ipcMain.once('editor:savedAll', (_e, ok) => resolve(ok));
    win.webContents.send('editor:saveAll');
  });
}

// ---------------------------------------------------------------- browser panes

// Each browser pane is a view of its own laid over the pane, like a docked app
// window: the renderer says where, and hides it while a menu or dialog would
// be under it. Sign-ins and cookies are kept between launches.
const browsers = new Map();
let nextBrowser = 1;

// VibeCMD's own shortcuts still work while a page has the keyboard: they're
// handed to the renderer instead (see appShortcut in app.js), as are the
// browser keys it handles itself.
function isPaneShortcut(i) {
  const key = i.key.length === 1 ? i.key.toUpperCase() : i.key;
  if (i.control && i.shift && !i.alt && ['N', 'T', 'D', 'W', 'P', 'Enter'].includes(key)) return true;
  if (i.control && !i.alt && ['Tab', 'PageUp', 'PageDown'].includes(key)) return true;
  if (i.alt && !i.control && key === 'K') return true;
  if (i.alt && i.shift && !i.control && key.startsWith('Arrow')) return true;
  if (i.alt && !i.shift && !i.control && (key === 'ArrowLeft' || key === 'ArrowRight')) return true;
  if (i.control && !i.shift && !i.alt && (key === 'L' || key === 'R')) return true;
  return key === 'F5';
}

ipcMain.handle('browser:create', (_e, url) => {
  const id = nextBrowser++;
  const view = new WebContentsView({ webPreferences: { partition: 'persist:browser', sandbox: true } });
  view.setVisible(false);
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  browsers.set(id, view);
  const wc = view.webContents;
  const send = (what, ...args) => win?.webContents.send('browser:event', id, what, ...args);
  const sendUrl = () => send('url', wc.getURL(), wc.navigationHistory.canGoBack(), wc.navigationHistory.canGoForward());
  wc.on('did-navigate', sendUrl);
  wc.on('did-navigate-in-page', sendUrl);
  wc.on('page-title-updated', (_ev, title) => send('title', title));
  wc.on('did-start-loading', () => send('loading', true));
  wc.on('did-stop-loading', () => send('loading', false));
  wc.on('focus', () => send('focus'));
  wc.on('did-fail-load', (_ev, code, desc, failed, isMain) => {
    // -3: a navigation that was replaced by another one, not a real failure.
    if (isMain && code !== -3) send('failed', `${desc} (${failed})`);
  });
  wc.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown' || !isPaneShortcut(input)) return;
    ev.preventDefault();
    send('key', { key: input.key, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt });
  });
  // Links meant for a new tab open in a new browser pane; real popups (sign-in
  // windows, mostly) stay popups, so the page that opened them can hear back.
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (disposition === 'new-window') return { action: 'allow' };
    send('open', target);
    return { action: 'deny' };
  });
  wc.on('context-menu', (_ev, p) => {
    const items = [
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
    ];
    if (p.linkURL) {
      items.push(
        { label: 'Open link in a new pane', click: () => send('open', p.linkURL) },
        { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  wc.loadURL(url).catch(() => { /* reported by did-fail-load */ });
  return id;
});

// In the renderer's pixels, which are the window's once zoom is applied.
ipcMain.on('browser:place', (_e, id, x, y, w, h) => {
  const view = browsers.get(id);
  if (!view) return;
  const z = win.webContents.getZoomFactor();
  view.setBounds({ x: Math.round(x * z), y: Math.round(y * z), width: Math.round(w * z), height: Math.round(h * z) });
  view.setVisible(true);
});

ipcMain.on('browser:hide', (_e, id) => browsers.get(id)?.setVisible(false));

ipcMain.on('browser:do', (_e, id, action, arg) => {
  const wc = browsers.get(id)?.webContents;
  if (!wc) return;
  if (action === 'load') wc.loadURL(arg).catch(() => {});
  else if (action === 'back') wc.navigationHistory.goBack();
  else if (action === 'forward') wc.navigationHistory.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
  else if (action === 'focus') wc.focus();
  else if (action === 'devtools') wc.toggleDevTools();
});

function destroyBrowser(id) {
  const view = browsers.get(id);
  if (!view) return;
  browsers.delete(id);
  win?.contentView.removeChildView(view);
  view.webContents.close();
}

ipcMain.on('browser:destroy', (_e, id) => destroyBrowser(id));

ipcMain.handle('dialog:pickFolder', async (_e, { defaultPath, title, buttonLabel } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath,
    title,
    buttonLabel,
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('app:cursorOutside', () => {
  if (linuxDock?.cursorOutside) return linuxDock.cursorOutside();
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height;
});

ipcMain.handle('app:homedir', () => os.homedir());

ipcMain.handle('fs:folderFor', (_e, p) => {
  if (!p) return null;
  try {
    return fs.statSync(p).isDirectory() ? p : path.dirname(p);
  } catch {
    return null;
  }
});

ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.on('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// Manual update check: compare the running version with the latest GitHub release.
const REPO = 'XAlienX123/vibecmd';
const versionParts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
const isNewer = (a, b) => {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion();
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VibeCMD' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    return { current, latest: rel.tag_name, url: rel.html_url, newer: isNewer(rel.tag_name, current) };
  } catch (err) {
    return { current, error: err.message };
  }
});

app.whenReady().then(() => {
  // The default menu's shortcuts (Ctrl+R reload, Ctrl+W close, Alt to show the
  // menu bar) collide with terminal keys, and a reload would kill every session.
  Menu.setApplicationMenu(null);
  setUpSessionTracking();
  if (!IS_WIN) setUpShells();
  createWindow();
  // Docking outside windows: native/winhelper.cs on Windows, linuxdock.js on Linux.
  if (IS_WIN) startHelper();
  else startLinuxDock();
});

app.on('window-all-closed', () => {
  for (const proc of ptys.values()) killTree(proc, true);
  ptys.clear();
  app.quit();
});
