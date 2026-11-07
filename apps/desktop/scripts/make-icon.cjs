// Renders build/icon.png (1024×1024) with Electron: an ink square with a rising sun. Run: electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { join } = require('path');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
<radialGradient id="bg" cx="50%" cy="80%" r="80%"><stop offset="0" stop-color="#3a2414"/><stop offset=".55" stop-color="#1b140e"/><stop offset="1" stop-color="#110d0a"/></radialGradient>
<radialGradient id="sun" cx="42%" cy="36%" r="70%"><stop offset="0" stop-color="#fff3d6"/><stop offset=".38" stop-color="#ffb347"/><stop offset=".78" stop-color="#ff7a3d"/><stop offset="1" stop-color="#b2421c"/></radialGradient>
<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffb347" stop-opacity=".55"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
<clipPath id="c"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
</defs>
<g clip-path="url(#c)">
<rect x="100" y="100" width="824" height="824" fill="url(#bg)"/>
<circle cx="512" cy="560" r="330" fill="url(#glow)"/>
<circle cx="512" cy="560" r="196" fill="url(#sun)"/>
<rect x="100" y="690" width="824" height="240" fill="#110d0a" opacity=".92"/>
<line x1="180" y1="690" x2="844" y2="690" stroke="#ffb347" stroke-width="10" stroke-linecap="round" opacity=".9"/>
<line x1="300" y1="750" x2="724" y2="750" stroke="#ffb347" stroke-width="8" stroke-linecap="round" opacity=".45"/>
<line x1="400" y1="802" x2="624" y2="802" stroke="#ffb347" stroke-width="6" stroke-linecap="round" opacity=".25"/>
</g>
<rect x="100.5" y="100.5" width="823" height="823" rx="186" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="3"/>
</svg>`;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  require('fs').writeFileSync(join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('wrote build/icon.png', img.getSize());
  app.quit();
});
