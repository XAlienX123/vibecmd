// Draws the VibeCMD icon and adds VibeCMD to the Start menu (so Windows search
// finds it). Run with:  npm run install-shortcut
// Pass --desktop to also put a shortcut on the desktop.
const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SIZES = [256, 64, 48, 32, 24, 16];

// Rendered in a hidden window's canvas: a dark rounded tile with an orange
// ">" prompt, a blue "_" cursor and a small Claude-style sparkle.
const DRAW = `
  (sizes) => sizes.map((S) => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const r = S * 0.22;
    g.beginPath();
    g.roundRect(S * 0.02, S * 0.02, S * 0.96, S * 0.96, r);
    const bg = g.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, '#2d3050');
    bg.addColorStop(1, '#14141c');
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = Math.max(1, S * 0.02);
    g.strokeStyle = '#3d4166';
    g.stroke();

    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, S * 0.1);
    g.strokeStyle = '#d97757';
    g.beginPath();
    g.moveTo(S * 0.22, S * 0.32);
    g.lineTo(S * 0.44, S * 0.52);
    g.lineTo(S * 0.22, S * 0.72);
    g.stroke();

    g.strokeStyle = '#7aa2f7';
    g.beginPath();
    g.moveTo(S * 0.54, S * 0.72);
    g.lineTo(S * 0.78, S * 0.72);
    g.stroke();

    if (S >= 24) {
      const cx = S * 0.70, cy = S * 0.30, R = S * 0.13, k = R * 0.22;
      g.fillStyle = '#d97757';
      g.beginPath();
      g.moveTo(cx, cy - R);
      g.quadraticCurveTo(cx + k, cy - k, cx + R, cy);
      g.quadraticCurveTo(cx + k, cy + k, cx, cy + R);
      g.quadraticCurveTo(cx - k, cy + k, cx - R, cy);
      g.quadraticCurveTo(cx - k, cy - k, cx, cy - R);
      g.fill();
    }
    return c.toDataURL('image/png');
  })`;

// An .ico is a small directory header followed by the PNG images themselves.
function buildIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html></html>');
  const urls = await win.webContents.executeJavaScript(`(${DRAW})(${JSON.stringify(SIZES)})`);
  const pngs = urls.map((u, i) => ({ size: SIZES[i], data: Buffer.from(u.split(',')[1], 'base64') }));

  fs.mkdirSync(BUILD, { recursive: true });
  const ico = path.join(BUILD, 'icon.ico');
  fs.writeFileSync(ico, buildIco(pngs));
  fs.writeFileSync(path.join(BUILD, 'icon.png'), pngs[0].data);

  const link = {
    target: process.execPath,
    args: `"${ROOT}"`,
    cwd: ROOT,
    icon: ico,
    iconIndex: 0,
    description: 'Tiling workspace for Claude Code and CMD sessions',
    appUserModelId: 'VibeCMD',
  };
  const places = [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'VibeCMD.lnk')];
  if (process.argv.includes('--desktop')) places.push(path.join(app.getPath('desktop'), 'VibeCMD.lnk'));

  for (const p of places) {
    const ok = shell.writeShortcutLink(p, 'replace', link) || shell.writeShortcutLink(p, 'create', link);
    console.log(ok ? `Created ${p}` : `FAILED to create ${p}`);
  }
  app.quit();
});
