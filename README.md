# VibeCMD

A tiling workspace for [Claude Code](https://claude.com/claude-code) and terminal sessions. It runs on Windows and Linux.

- Split the window into as many Claude, shell and PowerShell panes as you like, in tabs, and drag them around.
- Each Claude pane remembers its own chat. After a restart, every pane reopens the exact chat it was on, in the same folder.
- Panes name themselves after what they're doing:
  - a Claude pane takes the chat's topic;
  - a shell pane takes the running command, or its folder's name while idle.

  Rename a pane yourself to stop this.
- A pulsing dot shows panes that are still working. VibeCMD asks before you close a pane that is busy.
- Saved layouts, a right-click wheel, themes, and pop-out into a normal terminal window.
- Editor panes: a built-in text editor (the one VS Code is made of) with tabs for open files, syntax colours, find and replace. It works the same on Windows and Linux. Files Claude edits reload by themselves, with the changed lines lit up.
- Browser panes: a web page in a pane, with an address bar. Sign-ins are kept between launches.
- Docking: on Windows, drag an open CMD window onto VibeCMD to dock it into a pane. Other app windows dock the same way and work as usual inside their pane. On Linux (X11, needs `xdotool` and `xprop`), right-click and choose **Dock a window…** to dock an app window.

Press **Help** in the app for the full list of controls.

## Requirements

`claude` (Claude Code) must be on your `PATH` for Claude panes. Shell panes work without it.

## Install

Run one command. Run it again later to update.

Every push to `main` is built and published as the newest release, so the command always installs `main` as it is now.

**Windows** (CMD):

```bat
powershell -c "irm https://raw.githubusercontent.com/XAlienX123/vibecmd/main/install.ps1 | iex"
```

In PowerShell, run the part between the quotes. The script installs VibeCMD for your user only, so no admin prompt appears.

**Linux** (Konsole or any terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/XAlienX123/vibecmd/main/install.sh | sh
```

The script installs the pacman package on Arch-based distros and the .deb on Debian-based distros. On other distros, it installs the AppImage to `~/.local/bin`.

### With a package manager

**Scoop** (Windows):

```bat
scoop bucket add vibecmd https://github.com/XAlienX123/vibecmd
scoop install vibecmd
```

**AUR** (Arch, CachyOS, Manjaro):

```sh
yay -S vibecmd-bin
```

### Manual download

Download the file for your system from the [Releases](../../releases) page.

#### Windows

- `VibeCMD-Setup-x.y.z.exe`: the installer.
- `VibeCMD-x.y.z-portable.exe`: a single exe that needs no install.

#### Linux

| Distro | File | Install |
| --- | --- | --- |
| Arch, CachyOS, Manjaro, EndeavourOS | `vibecmd-x.y.z.pacman` | `sudo pacman -U vibecmd-*.pacman` |
| Debian, Ubuntu, Mint, Pop!_OS | `vibecmd_x.y.z_amd64.deb` | `sudo apt install ./vibecmd_*.deb` |
| Any distro | `VibeCMD-x.y.z.AppImage` | `chmod +x VibeCMD-*.AppImage && ./VibeCMD-*.AppImage` |
| Any distro | `vibecmd-x.y.z.tar.gz` | Extract it and run `./vibecmd` |

The AppImage needs FUSE 2. On Arch or CachyOS, install it with `sudo pacman -S fuse2`.

On Linux:

- A "Terminal" pane runs your own shell (`$SHELL`). VibeCMD supports bash, zsh and fish fully, so the pane follows `cd`.
- PowerShell panes use `pwsh` if it is installed.
- Pop out opens the first terminal it finds: konsole, gnome-terminal, kitty, alacritty, wezterm, ghostty, foot, xfce4-terminal or xterm.

## Run from source

```sh
git clone https://github.com/XAlienX123/vibecmd.git
cd vibecmd
npm install
npm start
```

On Linux, `npm install` compiles `node-pty`, so you need a C++ toolchain and Python:

- Arch or CachyOS: `sudo pacman -S base-devel python`
- Debian or Ubuntu: `sudo apt install build-essential python3`

On Windows, `npm run install-shortcut` adds VibeCMD to the Start menu. Add `-- --desktop` to also put a shortcut on the desktop.

## Build packages

```sh
npm run dist:linux   # AppImage, pacman, deb, tar.gz in dist/
npm run dist:win     # installer + portable exe in dist/
```

Each package must be built on its own OS. GitHub Actions (`.github/workflows/build.yml`) builds both. It attaches them to a release when you push a `v*` tag.
