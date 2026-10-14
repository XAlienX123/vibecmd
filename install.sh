#!/bin/sh
# Installs (or updates) VibeCMD from the latest GitHub release, which is
# built from main on every push.
#   curl -fsSL https://raw.githubusercontent.com/XAlienX123/vibecmd/main/install.sh | sh
# Uses the native package on Arch-based and Debian-based distros, and the
# AppImage everywhere else.
set -eu

REPO="XAlienX123/vibecmd"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Linux ] || die "this script is for Linux. On Windows, see the README."
[ "$(uname -m)" = x86_64 ] || die "only x86_64 builds are published so far."

if have curl; then
  fetch() { curl -fsSL "$1"; }
  download() { curl -fL --progress-bar -o "$2" "$1"; }
elif have wget; then
  fetch() { wget -qO- "$1"; }
  download() { wget -q --show-progress -O "$2" "$1"; }
else
  die "curl or wget is required."
fi

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# Picks the download URL of the release asset whose name ends with $1.
asset_url() {
  fetch "$API" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 | grep -E "$1\$" | head -n1
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if have pacman; then
  url=$(asset_url '\.pacman') || true
  [ -n "$url" ] || die "no .pacman package in the latest release."
  say "Downloading $(basename "$url")"
  download "$url" "$TMP/$(basename "$url")"
  say "Installing with pacman"
  $SUDO pacman -U --noconfirm "$TMP/$(basename "$url")"
elif have apt-get && have dpkg; then
  url=$(asset_url '_amd64\.deb') || true
  [ -n "$url" ] || die "no .deb package in the latest release."
  say "Downloading $(basename "$url")"
  download "$url" "$TMP/vibecmd.deb"
  chmod 644 "$TMP/vibecmd.deb"
  chmod 755 "$TMP"
  say "Installing with apt"
  $SUDO apt-get install -y --reinstall "$TMP/vibecmd.deb"
else
  url=$(asset_url '\.AppImage') || true
  [ -n "$url" ] || die "no AppImage in the latest release."
  BIN="$HOME/.local/bin"
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
  mkdir -p "$BIN" "$APPS" "$ICONS"
  say "Downloading $(basename "$url")"
  download "$url" "$BIN/vibecmd"
  chmod +x "$BIN/vibecmd"
  fetch "https://raw.githubusercontent.com/$REPO/main/build/icon.png" > "$ICONS/vibecmd.png" || true
  cat > "$APPS/vibecmd.desktop" <<EOF
[Desktop Entry]
Name=VibeCMD
Comment=Tiling workspace for Claude Code and terminal sessions
Exec=$BIN/vibecmd %U
Icon=vibecmd
Terminal=false
Type=Application
Categories=Development;
EOF
  say "Installed the AppImage to $BIN/vibecmd"
  case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH to run 'vibecmd' from a terminal." ;; esac
  say "The AppImage needs FUSE 2 (libfuse2 / fuse2 / fuse-libs on most distros)."
fi

have claude || say "Claude panes need 'claude' (Claude Code) on your PATH: https://claude.com/claude-code"
say "Done. Run 'vibecmd' or find VibeCMD in your app menu."
