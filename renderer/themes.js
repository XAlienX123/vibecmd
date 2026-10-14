'use strict';

// Each theme sets the page's CSS variables (`ui`, see :root in style.css) and
// the terminals' colours (`term`). Docked CMD windows use the terminal colours
// too, since their screen is drawn by a normal pane.
const THEMES = {
  'Tokyo Night': {
    ui: {
      bg: '#16161e', panel: '#1f2030', 'panel-hi': '#2a2c42', border: '#2f3149', text: '#c8cbe0',
      muted: '#7a7f9e', accent: '#d97757', cmd: '#7aa2f7', ps: '#9ece6a', docked: '#e0af68',
      danger: '#8a2a2a', 'term-bg': '#16161e',
    },
    term: {
      background: '#16161e', foreground: '#c8cbe0', cursor: '#d97757', selectionBackground: '#3b3f5c',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  // Classic Windows console look: black background, grey text and the
  // Campbell colours CMD uses by default.
  Dark: {
    ui: {
      bg: '#000000', panel: '#0c0c0c', 'panel-hi': '#1c1c1c', border: '#333333', text: '#cccccc',
      muted: '#808080', accent: '#d97757', cmd: '#3b78ff', ps: '#16c60c', docked: '#f9f1a5',
      danger: '#8b1a1a', 'term-bg': '#0c0c0c',
    },
    term: {
      background: '#0c0c0c', foreground: '#cccccc', cursor: '#cccccc', selectionBackground: '#444444',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
      blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
      brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
  },
};

const DEFAULT_THEME = 'Tokyo Night';
