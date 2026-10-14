'use strict';

/*
 * Browser panes: a web page in a pane. The address bar is part of the pane;
 * the page is a view of its own laid over the rest of it (see "browser panes"
 * in main.js), placed and hidden along with docked app windows (syncApps in
 * app.js). Pages stay signed in between launches. A link that would open a
 * new tab opens a new browser pane next to this one.
 *
 * Uses app.js's globals (sessions, save, autoTitle...); loaded before it.
 */

const HOME_URL = 'https://www.google.com/';

function setupBrowserPane(s) {
  s.termEl.classList.add('browser-pane');
  s.termEl.innerHTML = `
    <form class="br-bar">
      <button type="button" data-do="back" title="Back (Alt+Left)" disabled>←</button>
      <button type="button" data-do="forward" title="Forward (Alt+Right)" disabled>→</button>
      <button type="button" data-do="reload" title="Reload (F5)">↻</button>
      <input class="br-url" spellcheck="false" placeholder="Search, or type an address (Ctrl+L)" />
      <button type="button" data-do="external" title="Open in your normal browser">⇱</button>
    </form>
    <div class="br-view"></div>`;
  s.urlInput = s.termEl.querySelector('.br-url');
  s.viewEl = s.termEl.querySelector('.br-view');
  s.urlInput.value = s.url || '';
  const bar = s.termEl.querySelector('.br-bar');
  bar.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!s.urlInput.value.trim()) return;
    browse(s, toUrl(s.urlInput.value));
    deck.browserDo(s.browserId, 'focus');
  });
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.do;
    if (!act || s.browserId == null) return;
    if (act === 'external') deck.openExternal(s.url || '');
    else if (act === 'reload') deck.browserDo(s.browserId, s.loading ? 'stop' : 'reload');
    else deck.browserDo(s.browserId, act);
  });
  s.urlInput.addEventListener('focus', () => s.urlInput.select());
  s.urlInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    s.urlInput.value = s.url || '';
    deck.browserDo(s.browserId, 'focus');
  });
}

// What's typed in the address bar: an address as it is (https:// added if it
// has none; http:// for localhost), anything else is searched for.
function toUrl(text) {
  const t = text.trim();
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

function browse(s, url) {
  s.url = url;
  s.urlInput.value = url;
  if (s.browserId != null) deck.browserDo(s.browserId, 'load', url);
  save();
}

// The first time the pane is on screen.
async function openBrowserPane(s) {
  const id = await deck.createBrowser(s.url || HOME_URL);
  if (!sessions.has(s.id)) { deck.destroyBrowser(id); return; }
  s.browserId = id;
  syncApps();
  if (focusedId === s.id) focusPane(s);
}

function closeBrowserPane(s) {
  if (s.browserId == null) return;
  deck.destroyBrowser(s.browserId);
  appPlaced.delete(`b${s.browserId}`);
  s.browserId = null;
}

// A new browser pane on `url`, next to pane `near` (or the focused one).
function openBrowser(url, { near } = {}) {
  newSession('browser', { cwd: near?.cwd, near: near?.id, extra: { url } });
}

const browserPane = (id) => [...sessions.values()].find((s) => s.browserId === id);

deck.onBrowserEvent((id, what, ...args) => {
  const s = browserPane(id);
  if (!s) return;
  if (what === 'url') {
    const [url, back, forward] = args;
    s.url = url;
    if (document.activeElement !== s.urlInput) s.urlInput.value = url;
    const p = s.el.querySelector('.path');
    p.textContent = p.title = url;
    s.termEl.querySelector('[data-do="back"]').disabled = !back;
    s.termEl.querySelector('[data-do="forward"]').disabled = !forward;
    save();
  } else if (what === 'title') {
    autoTitle(s, args[0]);
  } else if (what === 'loading') {
    s.loading = args[0];
    s.el.classList.toggle('loading', s.loading);
    const reload = s.termEl.querySelector('[data-do="reload"]');
    reload.textContent = s.loading ? '✕' : '↻';
    reload.title = s.loading ? 'Stop' : 'Reload (F5)';
    if (s.loading) s.el.querySelector('.status').textContent = '';
  } else if (what === 'failed') {
    s.el.querySelector('.status').textContent = args[0];
  } else if (what === 'focus') {
    if (focusedId !== s.id) setFocus(s.id);
  } else if (what === 'open') {
    openBrowser(args[0], { near: s });
  } else if (what === 'key') {
    browserKey(s, args[0]);
  }
});

// Keys pressed in a page that VibeCMD handles (main.js picks them out).
function browserKey(s, e) {
  const key = e.key.toUpperCase();
  if (e.ctrlKey && !e.shiftKey && key === 'L') {
    s.urlInput.focus();
  } else if ((e.ctrlKey && !e.shiftKey && key === 'R') || key === 'F5') {
    deck.browserDo(s.browserId, 'reload');
  } else if (e.altKey && !e.shiftKey && !e.ctrlKey && (key === 'ARROWLEFT' || key === 'ARROWRIGHT')) {
    deck.browserDo(s.browserId, key === 'ARROWLEFT' ? 'back' : 'forward');
  } else {
    appShortcut(e);
  }
}
