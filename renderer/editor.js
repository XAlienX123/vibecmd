'use strict';

/*
 * Editor panes: a text editor built in (Monaco, the editor VS Code is made
 * of), so editing works the same on Windows and Linux and looks like the rest
 * of VibeCMD. Each pane has its open files along its top, like Notepad++.
 *
 * An open file is one document shared by every pane that has it, so two panes
 * on the same file show the same text and the same unsaved changes. Files are
 * watched: a change made outside (Claude's edits, say) is loaded straight away
 * and the changed lines light up for a moment. With unsaved changes here the
 * pane asks instead (Reload / Keep mine).
 *
 * Uses app.js's globals (sessions, save, autoTitle...); loaded before it.
 */

let monacoReady = null;

// Monaco's AMD loader (loader.js, in index.html) loads the rest on first use.
function loadMonaco() {
  monacoReady ??= new Promise((resolve) => {
    // Absolute, so Monaco's web workers (which run from a blob: URL) find it too.
    require.config({ paths: { vs: new URL('../node_modules/monaco-editor/min/vs', location.href).href } });
    require(['vs/editor/editor.main'], () => {
      setEditorTheme();
      resolve();
    });
  });
  return monacoReady;
}

// The editor takes its colours from the terminal theme.
function setEditorTheme() {
  if (!window.monaco) return;
  const t = THEMES[themeName];
  monaco.editor.defineTheme('vibecmd', {
    base: themeIsLight ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': t.term.background,
      'editor.foreground': t.term.foreground,
      'editorCursor.foreground': t.term.cursor,
      'editor.selectionBackground': t.term.selectionBackground,
      'editor.lineHighlightBackground': t.ui.panel,
      'editor.lineHighlightBorder': t.ui.panel,
      'editorLineNumber.foreground': t.ui.muted,
      'editorLineNumber.activeForeground': t.ui.text,
      'editorWidget.background': t.ui.panel,
      'editorWidget.border': t.ui.border,
      'editorSuggestWidget.background': t.ui.panel,
      'editorSuggestWidget.border': t.ui.border,
      'minimap.background': t.term.background,
    },
  });
  monaco.editor.setTheme('vibecmd');
}

// ---------------------------------------------------------------- documents

// key -> { key, file, model, saved, encoding, bom, refs, onDisk, flash }.
// `saved` is the model's version at the last load or save; `file` is null for
// a new file that hasn't been saved yet.
const docs = new Map();
let untitledCount = 0;

const docKey = (file) => (IS_WIN ? file.replace(/\//g, '\\').toLowerCase() : file);
const docName = (d) => (d.file ? folderName(d.file) : d.name);
const isDirty = (d) => !!d.model && d.model.getAlternativeVersionId() !== d.saved;

// The document for `file` (a new, empty one for null), loaded if it isn't
// open yet. Every acquireDoc is paired with a releaseDoc.
async function acquireDoc(file) {
  await loadMonaco();
  if (!file) {
    const n = ++untitledCount;
    const d = { key: `untitled:${n}`, file: null, name: `Untitled-${n}`, refs: 1, encoding: 'utf8', bom: false };
    d.model = monaco.editor.createModel('', 'plaintext', monaco.Uri.parse(`untitled:Untitled-${n}`));
    docReady(d);
    return d;
  }
  const key = docKey(file);
  let d = docs.get(key);
  if (!d) {
    d = { key, file, refs: 0 };
    docs.set(key, d);
    d.loading = deck.readFile(file).then((r) => {
      d.loading = null;
      if (r.error) { d.error = r.error; docs.delete(key); return; }
      d.encoding = r.encoding;
      d.bom = r.bom;
      d.model = monaco.editor.createModel(r.text, undefined, monaco.Uri.file(file));
      docReady(d);
      deck.watchFile(file);
    });
  }
  await d.loading;
  if (d.error) return { error: d.error };
  d.refs++;
  return d;
}

function docReady(d) {
  docs.set(d.key, d);
  d.saved = d.model.getAlternativeVersionId();
  d.wasDirty = false;
  d.model.onDidChangeContent(() => {
    if (isDirty(d) !== d.wasDirty) refreshDoc(d);
  });
}

function releaseDoc(d) {
  if (--d.refs > 0) return;
  docs.delete(d.key);
  d.model.dispose();
  if (d.file) deck.unwatchFile(d.file);
  updateUnsavedCount();
}

const panesWith = (d) => [...sessions.values()].filter((s) => s.docs?.includes(d));

// Shows a document's saved / unsaved / changed-on-disk state everywhere.
function refreshDoc(d) {
  d.wasDirty = isDirty(d);
  for (const s of panesWith(d)) {
    renderFiles(s);
    paneUnsaved(s);
    updateBar(s);
  }
  updateUnsavedCount();
}

function updateUnsavedCount() {
  deck.setUnsavedCount([...docs.values()].filter(isDirty).length);
}

// Resolves false if it wasn't saved (an error, or Save as… cancelled).
async function saveDoc(d, s) {
  if (!d.file) return saveDocAs(s, d);
  const err = await deck.writeFile(d.file, d.model.getValue(), { encoding: d.encoding, bom: d.bom });
  if (err) {
    alert(`Couldn't save ${d.file}:\n${err}`);
    return false;
  }
  d.saved = d.model.getAlternativeVersionId();
  d.onDisk = false;
  refreshDoc(d);
  return true;
}

// The text goes to the new file, which takes the old one's place in this pane.
async function saveDocAs(s, d) {
  if (!s) return false;
  const file = await deck.saveFile({ defaultPath: d.file || `${s.cwd}${IS_WIN ? '\\' : '/'}${docName(d)}.txt`, title: 'Save as' });
  if (!file) return false;
  if (d.file && docKey(file) === d.key) return saveDoc(d, s);
  const err = await deck.writeFile(file, d.model.getValue(), { encoding: d.encoding, bom: d.bom });
  if (err) {
    alert(`Couldn't save ${file}:\n${err}`);
    return false;
  }
  if (!d.file) d.saved = d.model.getAlternativeVersionId();
  const fresh = await acquireDoc(file);
  if (fresh.error || !sessions.has(s.id)) return !fresh.error;
  // Already open here as well: just one tab for it.
  if (s.docs.includes(fresh)) releaseDoc(fresh);
  else s.docs.splice(s.docs.indexOf(d), 0, fresh);
  dropDoc(s, d);
  showDoc(s, fresh);
  return true;
}

// Loads a file's new contents from disk, as an edit (so Ctrl+Z brings back
// what was there) of just the part that changed, which lights up for a moment.
async function reloadDoc(d, force = false) {
  if (!d.model || !d.file) return;
  const r = await deck.readFile(d.file);
  if (r.error || !d.model || d.model.isDisposed()) return;
  const model = d.model;
  const old = model.getValue();
  const text = r.text.replace(/\r\n|\r|\n/g, model.getEOL());
  if (text === old) {
    if (d.onDisk) { d.onDisk = false; refreshDoc(d); }
    return;
  }
  if (isDirty(d) && !force) {
    d.onDisk = true;
    refreshDoc(d);
    return;
  }
  let a = 0;
  while (a < old.length && a < text.length && old[a] === text[a]) a++;
  let b = 0;
  while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
  const from = model.getPositionAt(a);
  const to = model.getPositionAt(old.length - b);
  const insert = text.slice(a, text.length - b);
  model.pushStackElement();
  model.pushEditOperations([], [{ range: monaco.Range.fromPositions(from, to), text: insert }], () => null);
  model.pushStackElement();
  d.encoding = r.encoding;
  d.bom = r.bom;
  d.saved = model.getAlternativeVersionId();
  d.onDisk = false;
  const last = model.getPositionAt(a + insert.length).lineNumber;
  flashLines(d, from.lineNumber, Math.max(from.lineNumber, insert.endsWith(model.getEOL()) ? last - 1 : last));
  refreshDoc(d);
}

function flashLines(d, first, last) {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--docked').trim() || '#e0af68';
  d.flash = d.model.deltaDecorations(d.flash || [], [{
    range: new monaco.Range(first, 1, last, 1),
    options: {
      isWholeLine: true,
      className: 'ed-changed',
      overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Full },
      minimap: { color, position: monaco.editor.MinimapPosition.Inline },
    },
  }]);
  for (const s of panesWith(d)) {
    if (s.active === d) s.editor.revealLinesInCenterIfOutsideViewport(first, last);
  }
  clearTimeout(d.flashTimer);
  d.flashTimer = setTimeout(() => {
    if (!d.model.isDisposed()) d.flash = d.model.deltaDecorations(d.flash, []);
  }, 4000);
}

deck.onFileChanged((file) => {
  const d = docs.get(docKey(file));
  if (d) reloadDoc(d);
});

// Quitting with unsaved files, "Save all". New files ask where to go, in
// their pane.
deck.onSaveAll(async () => {
  for (const d of [...docs.values()]) {
    if (!isDirty(d)) continue;
    const s = panesWith(d)[0];
    if (!d.file && s) {
      goToPane(s.id);
      showDoc(s, d);
    }
    if (!await saveDoc(d, s)) return false;
  }
  return true;
});

// ---------------------------------------------------------------- panes

function setupEditorPane(s) {
  s.docs = [];
  s.active = null;
  s.views = new Map();
  s.termEl.classList.add('editor-pane', 'no-file');
  s.termEl.innerHTML = `
    <div class="ed-files"></div>
    <div class="ed-host"></div>
    <div class="ed-empty">
      <button data-do="open">Open file… <kbd>Ctrl+O</kbd></button>
      <button data-do="new">New file <kbd>Ctrl+N</kbd></button>
    </div>
    <div class="ed-bar"><span class="ed-disk"></span><span class="ed-note"></span><span class="ed-info"></span><span class="ed-pos"></span></div>`;
  s.termEl.querySelector('.ed-empty').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.do;
    if (act === 'open') pickIntoPane(s);
    else if (act === 'new') openInPane(s, null);
  });
  // Before Monaco sees them, so they work with or without a file open.
  s.termEl.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const key = e.key.toUpperCase();
    if (key === 'S') {
      if (s.active) (e.shiftKey ? saveDocAs(s, s.active) : saveDoc(s.active, s));
    } else if (e.shiftKey) {
      return;
    } else if (key === 'O') {
      pickIntoPane(s);
    } else if (key === 'N') {
      openInPane(s, null);
    } else if (key === 'W') {
      if (s.active) closeDocInPane(s, s.active);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// The first time the pane is on screen: the editor, and the files it had open.
async function openEditorPane(s) {
  await loadMonaco();
  if (!sessions.has(s.id)) return;
  s.editor = monaco.editor.create(s.termEl.querySelector('.ed-host'), {
    model: null,
    theme: 'vibecmd',
    automaticLayout: true,
    fontFamily: TERM_FONT,
    fontSize: s.term.options.fontSize,
    // Right-click is VibeCMD's (the pane menu has Cut / Copy / Paste / Find).
    contextmenu: false,
    minimap: { enabled: true, renderCharacters: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    fixedOverflowWidgets: true,
    wordWrap: s.wrap ? 'on' : 'off',
  });
  s.editor.onDidChangeCursorPosition(() => updatePos(s));
  s.editor.onDidFocusEditorText(() => { if (focusedId !== s.id) setFocus(s.id); });
  s.editor.addAction({
    id: 'vibecmd.wrap', label: 'Toggle word wrap', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
    run: () => toggleWrap(s),
  });
  addNotepadKeys(s);
  const files = s.files;
  const active = s.file;
  for (const f of files) await openInPane(s, f, { show: false });
  const first = s.docs.find((d) => active && d.key === docKey(active)) || s.docs[0];
  if (first) showDoc(s, first);
  else renderFiles(s);
  if (focusedId === s.id) s.editor.focus();
}

// Notepad++'s line and case shortcuts, on top of Monaco's own. They take over
// the keys Monaco uses for other things (Ctrl+D, Ctrl+U, Ctrl+L...).
const NOTEPAD_KEYS = [
  ['Duplicate line', 'editor.action.copyLinesDownAction', 'CtrlCmd | KeyD'],
  ['Delete line', 'editor.action.deleteLines', 'CtrlCmd | KeyL'],
  ['Move line up', 'editor.action.moveLinesUpAction', 'CtrlCmd | Shift | UpArrow'],
  ['Move line down', 'editor.action.moveLinesDownAction', 'CtrlCmd | Shift | DownArrow'],
  ['Join lines', 'editor.action.joinLines', 'CtrlCmd | KeyJ'],
  ['To lowercase', 'editor.action.transformToLowercase', 'CtrlCmd | KeyU'],
  ['To UPPERCASE', 'editor.action.transformToUppercase', 'CtrlCmd | Shift | KeyU'],
  ['Toggle line comment', 'editor.action.commentLine', 'CtrlCmd | KeyQ'],
  ['Toggle block comment', 'editor.action.blockComment', 'CtrlCmd | Shift | KeyQ'],
];

function addNotepadKeys(s) {
  const code = (name) => (name === 'CtrlCmd' ? monaco.KeyMod.CtrlCmd : name === 'Shift' ? monaco.KeyMod.Shift : monaco.KeyCode[name]);
  for (const [label, id, keys] of NOTEPAD_KEYS) {
    s.editor.addAction({
      id: `vibecmd.${id}`,
      label,
      keybindings: [keys.split(' | ').reduce((sum, k) => sum | code(k), 0)],
      run: (ed) => ed.getAction(id)?.run(),
    });
  }
}

// Line endings and encoding are the file's, shown in the status line and
// changed from the pane menu. Both count as an unsaved change.
function setEol(d, crlf) {
  d.model.setEOL(crlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
}

function setEncoding(d, encoding, bom) {
  if (d.encoding === encoding && d.bom === bom) return;
  d.encoding = encoding;
  d.bom = bom;
  d.saved = 0; // never a version the model has, so it's unsaved until saved
  refreshDoc(d);
}

function toggleSymbols(s) {
  s.symbols = !s.symbols;
  s.editor.updateOptions({ renderWhitespace: s.symbols ? 'all' : 'selection', renderControlCharacters: !!s.symbols });
}

// Opens `file` (a new file for null) in a pane, or switches to it if it's open
// there already. Resolves with its document, or null.
async function openInPane(s, file, { show = true } = {}) {
  const there = file && s.docs.find((d) => d.key === docKey(file));
  if (there) {
    if (show) showDoc(s, there);
    return there;
  }
  const d = await acquireDoc(file);
  if (d.error) {
    editorNote(s, `Couldn't open ${folderName(file)}: ${d.error}`);
    return null;
  }
  // Closed meanwhile, or opened twice at once.
  if (!sessions.has(s.id) || s.docs.includes(d)) {
    releaseDoc(d);
    return sessions.has(s.id) ? d : null;
  }
  s.docs.push(d);
  if (show) showDoc(s, d);
  else renderFiles(s);
  return d;
}

function showDoc(s, d) {
  if (!s.editor) return;
  if (s.active && s.active !== d) s.views.set(s.active.key, s.editor.saveViewState());
  s.active = d;
  s.editor.setModel(d?.model || null);
  if (d && s.views.has(d.key)) s.editor.restoreViewState(s.views.get(d.key));
  s.termEl.classList.toggle('no-file', !d);
  if (d) {
    if (d.file) {
      s.cwd = d.file.replace(/[\\/][^\\/]*$/, '');
      const p = s.el.querySelector('.path');
      p.textContent = p.title = d.file;
    }
    autoTitle(s, docName(d));
  }
  renderFiles(s);
  paneUnsaved(s);
  updateBar(s);
  save();
}

// Takes a document out of a pane without asking anything.
function dropDoc(s, d) {
  const i = s.docs.indexOf(d);
  if (i < 0) return;
  s.docs.splice(i, 1);
  s.views.delete(d.key);
  if (s.active === d) {
    s.active = null;
    showDoc(s, s.docs[Math.min(i, s.docs.length - 1)] || null);
  }
  releaseDoc(d);
  renderFiles(s);
  paneUnsaved(s);
  save();
}

// Unsaved changes only open here: save them first? Resolves false if the
// user cancelled (or saving failed), so nothing should close.
async function settleUnsaved(s, list) {
  const lost = list.filter((d) => isDirty(d) && d.refs === 1);
  if (!lost.length) return true;
  const names = lost.map(docName);
  const answer = await deck.askUnsaved({
    message: lost.length === 1 ? `Save changes to ${names[0]}?` : `Save changes to ${lost.length} files?`,
    detail: lost.length > 1 ? names.join('\n') : 'Your changes are lost if you don\'t save them.',
  });
  if (answer === 2) return false;
  if (answer === 1) return true;
  for (const d of lost) {
    if (!d.file) showDoc(s, d);
    if (!await saveDoc(d, s)) return false;
  }
  return true;
}

async function closeDocInPane(s, d) {
  if (!await settleUnsaved(s, [d])) return false;
  dropDoc(s, d);
  return true;
}

// The pane is closing. Resolves false if it has to stay.
async function closeEditorPane(s) {
  if (!s.docs?.length) return true;
  if (!await settleUnsaved(s, s.docs)) return false;
  for (const d of [...s.docs]) releaseDoc(d);
  s.docs = [];
  s.active = null;
  s.editor?.dispose();
  s.editor = null;
  return true;
}

async function pickIntoPane(s) {
  const file = await deck.pickFile({ defaultPath: s.active?.file || s.cwd || defaultCwd, title: 'Open which file?', buttonLabel: 'Open' });
  if (file) await openInPane(s, file);
  s.editor?.focus();
}

function toggleWrap(s) {
  s.wrap = !s.wrap;
  s.editor.updateOptions({ wordWrap: s.wrap ? 'on' : 'off' });
  updateBar(s);
  save();
}

// The pane's saved state: its files, and the one showing. Before the pane
// has been on screen, that's still what it was created with.
function editorState(s) {
  if (!s.editor) return { files: s.files, file: s.file };
  return { files: s.docs.filter((d) => d.file).map((d) => d.file), file: s.active?.file || null };
}

// Like unsaved files in a docked editor, the pane's title bar and tab show it.
function paneUnsaved(s) {
  const unsaved = s.docs.some(isDirty);
  if (unsaved === !!s.unsaved) return;
  s.unsaved = unsaved;
  s.el.classList.toggle('unsaved', unsaved);
  s.el.querySelector('.status').textContent = unsaved ? 'unsaved' : '';
  renderTabs();
}

function renderFiles(s) {
  const strip = s.termEl.querySelector('.ed-files');
  strip.replaceChildren(...s.docs.map((d) => {
    const tab = document.createElement('div');
    tab.className = 'ed-file' + (d === s.active ? ' on' : '') + (isDirty(d) ? ' dirty' : '');
    tab.title = d.file || 'Not saved yet';
    tab.innerHTML = '<span class="ed-file-name"></span><button title="Close (Ctrl+W)">✕</button>';
    tab.firstChild.textContent = docName(d);
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('button')) { showDoc(s, d); s.editor.focus(); }
    });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeDocInPane(s, d); });
    tab.lastChild.addEventListener('click', (e) => { e.stopPropagation(); closeDocInPane(s, d); });
    return tab;
  }));
  const add = document.createElement('button');
  add.className = 'ed-add';
  add.textContent = '+';
  add.title = 'Open a file (Ctrl+O), or a new one (Ctrl+N)';
  add.addEventListener('click', () => pickIntoPane(s));
  strip.append(add);
}

const ENCODING_LABEL = { utf8: 'UTF-8', utf16le: 'UTF-16 LE', latin1: 'ANSI' };

function updateBar(s) {
  const d = s.active;
  const info = s.termEl.querySelector('.ed-info');
  const disk = s.termEl.querySelector('.ed-disk');
  disk.replaceChildren();
  if (!d?.model) {
    info.textContent = '';
    updatePos(s);
    return;
  }
  const lang = monaco.languages.getLanguages().find((l) => l.id === d.model.getLanguageId());
  info.textContent = [
    lang?.aliases?.[0] || d.model.getLanguageId(),
    d.model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
    `${ENCODING_LABEL[d.encoding] || d.encoding}${d.bom ? ' BOM' : ''}`,
    s.wrap && 'Wrap',
  ].filter(Boolean).join('  ·  ');
  if (d.onDisk) {
    disk.append('Changed on disk. ');
    for (const [label, fn] of [['Reload', () => reloadDoc(d, true)], ['Keep mine', () => { d.onDisk = false; refreshDoc(d); }]]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      disk.append(b);
    }
  }
  updatePos(s);
}

function updatePos(s) {
  const pos = s.active && s.editor?.getPosition();
  s.termEl.querySelector('.ed-pos').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : '';
}

function editorNote(s, text) {
  const note = s.termEl.querySelector('.ed-note');
  note.textContent = text;
  clearTimeout(s.noteTimer);
  s.noteTimer = setTimeout(() => { note.textContent = ''; }, 8000);
}

// ---- the pane menu's editing entries

const editorSelection = (s) => (s.editor && s.active ? s.active.model.getValueInRange(s.editor.getSelection()) : '');

function replaceSelection(s, text) {
  s.editor.executeEdits('menu', [{ range: s.editor.getSelection(), text, forceMoveMarkers: true }]);
  s.editor.focus();
}

function editorMenuItems(s) {
  if (!s.editor || !s.active) return [];
  const sel = editorSelection(s);
  const run = (id) => () => { s.editor.focus(); s.editor.getAction(id)?.run(); };
  return [
    { sep: true },
    ...(sel ? [
      { label: 'Cut', run: () => { deck.copy(sel); replaceSelection(s, ''); } },
      { label: 'Copy', run: () => { deck.copy(sel); s.editor.focus(); } },
    ] : []),
    { label: 'Paste', run: async () => replaceSelection(s, await deck.paste()) },
    { label: 'Select all', run: () => { s.editor.setSelection(s.active.model.getFullModelRange()); s.editor.focus(); } },
    { label: 'Find… (Ctrl+F)', run: run('actions.find') },
    { label: 'Replace… (Ctrl+H)', run: run('editor.action.startFindReplaceAction') },
    { label: 'Go to line… (Ctrl+G)', run: run('editor.action.gotoLine') },
    { label: s.wrap ? '✓ Word wrap (Alt+Z)' : 'Word wrap (Alt+Z)', run: () => toggleWrap(s) },
    { label: s.symbols ? '✓ Show spaces and tabs' : 'Show spaces and tabs', run: () => { toggleSymbols(s); s.editor.focus(); } },
    { sep: true },
    { label: 'Duplicate line (Ctrl+D)', run: run('vibecmd.editor.action.copyLinesDownAction') },
    { label: 'Delete line (Ctrl+L)', run: run('vibecmd.editor.action.deleteLines') },
    { label: 'Toggle comment (Ctrl+Q)', run: run('vibecmd.editor.action.commentLine') },
    { label: 'To UPPERCASE (Ctrl+Shift+U)', run: run('vibecmd.editor.action.transformToUppercase') },
    { label: 'To lowercase (Ctrl+U)', run: run('vibecmd.editor.action.transformToLowercase') },
    { label: 'Sort lines', run: run('editor.action.sortLinesAscending') },
    { label: 'Trim trailing spaces', run: run('editor.action.trimTrailingWhitespace') },
    { sep: true },
    s.active.model.getEOL() === '\r\n'
      ? { label: 'Line endings: to Unix (LF)', run: () => setEol(s.active, false) }
      : { label: 'Line endings: to Windows (CRLF)', run: () => setEol(s.active, true) },
    { label: 'Encoding: UTF-8', run: () => setEncoding(s.active, 'utf8', false) },
    { label: 'Encoding: UTF-8 with BOM', run: () => setEncoding(s.active, 'utf8', true) },
    { label: 'Encoding: UTF-16 LE', run: () => setEncoding(s.active, 'utf16le', true) },
    { label: 'Encoding: ANSI', run: () => setEncoding(s.active, 'latin1', false) },
    { sep: true },
    { label: 'Save (Ctrl+S)', run: () => saveDoc(s.active, s) },
    { label: 'Save as… (Ctrl+Shift+S)', run: () => saveDocAs(s, s.active) },
  ];
}
