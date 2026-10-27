// Draws the "notes app" pictures the end-to-end test puts on screen: the problem copied into handwritten notes, then a wrong line, then
// the right answer. Rendered by Electron itself, so the test needs no browser download.
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const out = process.argv[process.argv.length - 1];
const page = (lines, extra = '') => `<!doctype html><html><body style="margin:0;width:900px;height:640px;background:#fffef6;font:30px 'Segoe Print','Comic Sans MS',cursive;color:#1b2a6b">
<div style="height:44px;background:#7719aa;color:#fff;font:15px 'Segoe UI';display:flex;align-items:center;padding:0 16px">Calc homework - OneNote</div>
<div style="padding:28px 44px;line-height:64px;background-image:repeating-linear-gradient(#fffef6 0 63px,#c9d6f0 63px 64px)">
<div style="font:20px 'Segoe UI';color:#555">Problem 2a. Find dy/dx for y = sin(3x²)</div>
${lines.map((l) => `<div>${l}</div>`).join('')}${extra}</div></body></html>`;

const pictures = {
  start: page(['y = sin(3x²)']),
  wrong: page(['y = sin(3x²)', 'dy/dx = cos(3x²)']),
  right: page(['y = sin(3x²)', 'dy/dx = cos(3x²) · 6x', '= 6x cos(3x²)  ✓']),
  upload: `<!doctype html><html><body style="margin:0;width:900px;height:640px;background:#fff;font:26px Georgia;padding:40px;box-sizing:border-box">
<h2>Worksheet 5</h2><p>1. Differentiate f(x) = (2x+1)<sup>5</sup>.</p><p>2a. Find dy/dx for y = sin(3x²).</p><p>2b. Find dy/dx for y = e<sup>4x</sup>.</p></body></html>`,
};

app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 900, height: 640, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  for (const [name, html] of Object.entries(pictures)) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 250));
    const img = await win.webContents.capturePage();
    writeFileSync(join(out, `${name}.png`), img.toPNG());
  }
  app.quit();
});
