const { contextBridge, ipcRenderer, webUtils } = require('electron');

const dataHandlers = new Map();
const exitHandlers = new Map();
// Output can arrive before the renderer has registered its handler.
const pending = new Map();

ipcRenderer.on('pty:data', (_e, id, data) => {
  const fn = dataHandlers.get(id);
  if (fn) fn(data);
  else pending.set(id, (pending.get(id) || '') + data);
});
// Same for docked windows' screens, keyed by window handle.
const dockedHandlers = new Map();
const dockedPending = new Map();
ipcRenderer.on('docked:data', (_e, hwnd, data) => {
  const fn = dockedHandlers.get(hwnd);
  if (fn) fn(data);
  else dockedPending.set(hwnd, (dockedPending.get(hwnd) || '') + data);
});
ipcRenderer.on('pty:exit', (_e, id, code) => {
  exitHandlers.get(id)?.(code);
  dataHandlers.delete(id);
  exitHandlers.delete(id);
});

contextBridge.exposeInMainWorld('deck', {
  platform: process.platform,
  // Windows build number, so xterm can match how ConPTY redraws on resize.
  windowsBuild: +process.getSystemVersion().split('.')[2] || 0,
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => {
    dataHandlers.delete(id);
    exitHandlers.delete(id);
    pending.delete(id);
    ipcRenderer.send('pty:kill', id);
  },
  onData: (id, fn) => {
    dataHandlers.set(id, fn);
    if (pending.has(id)) {
      fn(pending.get(id));
      pending.delete(id);
    }
  },
  onExit: (id, fn) => { exitHandlers.set(id, fn); },
  // (ptyId, sessionId) when a Claude pane starts, resumes or /clears a chat.
  onClaudeSession: (fn) => {
    ipcRenderer.on('pty:claudeSession', (_e, ptyId, sessionId) => fn(ptyId, sessionId));
  },
  // (ptyId, busy) when Claude starts or stops working on something.
  onBusy: (fn) => {
    ipcRenderer.on('pty:busy', (_e, ptyId, busy) => fn(ptyId, busy));
  },
  // Saved tabs and layout (JSON text), see save() in app.js.
  loadState: () => ipcRenderer.sendSync('state:load'),
  saveState: (json) => ipcRenderer.send('state:save', json),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  popOut: (opts) => ipcRenderer.invoke('pane:popOut', opts),
  // True when the mouse is outside the VibeCMD window (a pane dragged out of it).
  cursorOutside: () => ipcRenderer.invoke('app:cursorOutside'),
  homedir: () => ipcRenderer.invoke('app:homedir'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  // Outside CMD windows docked into a pane (see native/winhelper.cs).
  onWindowDrag: (fn) => {
    ipcRenderer.on('xdrag', (_e, phase, hwnd, x, y, over) => fn(phase, hwnd, x, y, over));
  },
  dockWindow: (hwnd) => ipcRenderer.invoke('docked:embed', hwnd),
  onWindowData: (hwnd, fn) => {
    dockedHandlers.set(hwnd, fn);
    if (dockedPending.has(hwnd)) {
      fn(dockedPending.get(hwnd));
      dockedPending.delete(hwnd);
    }
  },
  writeWindow: (hwnd, data) => ipcRenderer.send('docked:write', hwnd, data),
  resizeWindow: (hwnd, cols, rows) => ipcRenderer.send('docked:resize', hwnd, cols, rows),
  scrollWindow: (hwnd, lines) => ipcRenderer.send('docked:scroll', hwnd, lines),
  releaseWindow: (hwnd) => {
    dockedHandlers.delete(hwnd);
    dockedPending.delete(hwnd);
    ipcRenderer.send('docked:release', hwnd);
  },
  closeWindow: (hwnd) => {
    dockedHandlers.delete(hwnd);
    dockedPending.delete(hwnd);
    ipcRenderer.send('docked:close', hwnd);
  },
  setWindowBusy: (hwnd, busy) => ipcRenderer.send('docked:busy', hwnd, busy),
  onDockedGone: (fn) => { ipcRenderer.on('docked:gone', (_e, hwnd) => fn(hwnd)); },
  onDockedTitle: (fn) => { ipcRenderer.on('docked:title', (_e, hwnd, title) => fn(hwnd, title)); },
  // For things dragged in from Explorer: the folder to open a session in.
  folderForFile: (file) => ipcRenderer.invoke('fs:folderFor', webUtils.getPathForFile(file)),
  copy: (text) => ipcRenderer.send('clipboard:write', text),
  paste: () => ipcRenderer.invoke('clipboard:read'),
});
