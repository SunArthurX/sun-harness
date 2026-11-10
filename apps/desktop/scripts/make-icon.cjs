// Renders build/icon.png (1024×1024) with Electron. Run: electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { join } = require('path');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
<clipPath id="c"><rect x="64" y="64" width="896" height="896" rx="200"/></clipPath>
</defs>
<g clip-path="url(#c)">
<rect width="1024" height="1024" fill="#1c1410"/>
<g fill="#ff9f1a">
<rect x="492" y="168" width="40" height="92" rx="20"/>
<rect x="250" y="250" width="40" height="92" rx="20" transform="rotate(-42 270 296)"/>
<rect x="734" y="250" width="40" height="92" rx="20" transform="rotate(42 754 296)"/>
<rect x="150" y="470" width="92" height="40" rx="20"/>
<rect x="782" y="470" width="92" height="40" rx="20"/>
<rect x="286" y="690" width="40" height="92" rx="20" transform="rotate(48 306 736)"/>
<rect x="698" y="690" width="40" height="92" rx="20" transform="rotate(-48 718 736)"/>
<path d="M500 748c8 78 46 118 96 132" fill="none" stroke="#ff9f1a" stroke-width="40" stroke-linecap="round"/>
</g>
<circle cx="512" cy="512" r="196" fill="#ff9f1a"/>
<g fill="#2a1c14">
<ellipse cx="446" cy="486" rx="18" ry="20"/>
<ellipse cx="590" cy="478" rx="18" ry="20"/>
<rect x="392" y="430" width="78" height="16" rx="8" transform="rotate(-8 431 438)"/>
<rect x="548" y="408" width="86" height="16" rx="8" transform="rotate(18 591 416)"/>
<path d="M430 560c28 46 92 58 150 28" fill="none" stroke="#2a1c14" stroke-width="16" stroke-linecap="round"/>
</g>
<path d="M560 582c22 8 34 28 24 42-14 16-36 8-44-12-6-16 4-32 20-30z" fill="#e26a2c"/>
</g>
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
