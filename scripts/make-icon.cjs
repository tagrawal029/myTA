// Builds myTA's app icon (the light brown pixel book) from the same 16x16 pixel art as the logo in setup: crisp PNGs at every size
// Windows asks for, packed into resources/icon.ico, plus resources/icon256.png. Run with Electron: `electron scripts/make-icon.cjs`.
const { app, nativeImage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
// The art lives in the logo component; read it from there so the two can never drift apart.
const brand = readFileSync(join(root, 'src/renderer/shared/Brand.tsx'), 'utf8');
const ROWS = JSON.parse(`[${brand.match(/const ROWS = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
const COLORS = Object.fromEntries([...brand.match(/const COLORS[^{]*\{([^}]*)\}/)[1].matchAll(/(\w):\s*'(#[0-9a-f]{6})'/gi)].map((m) => [m[1], m[2]]));

/** The art scaled up by a whole number (nearest neighbour), so every pixel stays a sharp square. */
function png(size) {
  const k = size / 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const ch = ROWS[Math.floor(y / k)][Math.floor(x / k)];
      const hex = COLORS[ch];
      if (!hex) continue; // transparent
      const i = (y * size + x) * 4;
      buf[i] = parseInt(hex.slice(5, 7), 16); // B
      buf[i + 1] = parseInt(hex.slice(3, 5), 16); // G
      buf[i + 2] = parseInt(hex.slice(1, 3), 16); // R
      buf[i + 3] = 255;
    }
  return nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG();
}

/** An .ico holding PNG images (Windows Vista and later read these). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

app.whenReady().then(() => {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => ({ size, data: png(size) }));
  writeFileSync(join(root, 'resources/icon.ico'), ico(images));
  writeFileSync(join(root, 'resources/icon256.png'), images[images.length - 1].data);
  console.log(`icon.ico written (${sizes.join(', ')} px)`);
  app.quit();
});
