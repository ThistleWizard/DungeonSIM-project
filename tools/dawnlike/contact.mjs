/**
 * contact.mjs — generate contact sheets so manual tile-picking is fast.
 *
 *   npm run dawnlike:contact                  # Characters (default)
 *   node tools/dawnlike/contact.mjs Items Objects
 *
 * For each `*0.png` sheet in the given DawnLike subdirs it writes an upscaled, grid-lined PNG
 * to `tools/dawnlike/contact/` and an `index.html` that overlays a `col,row` label on every
 * tile. Open `contact/index.html` in a browser, read off the coordinates of the tiles you want,
 * and record them in `picks.mjs` (see README.md). The contact/ dir is gitignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { DAWNLIKE_ROOT, TILE, gridOf, readSheet, upscale, sheetBase } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'contact');
const SCALE = 6; // 16px tile → 96px in the contact sheet (readable, not huge)
const GRID = [255, 0, 170, 110]; // magenta gridlines
const TS = TILE * SCALE;

const subdirs = process.argv.slice(2).length ? process.argv.slice(2) : ['Characters'];
fs.mkdirSync(OUT, { recursive: true });

/** Draw gridlines every tile so boundaries are obvious. */
function drawGrid(png) {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (x % TS !== 0 && y % TS !== 0) continue;
      const i = (y * png.width + x) << 2;
      [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] = GRID;
    }
  }
  return png;
}

const sections = [];
for (const sub of subdirs) {
  const dir = path.join(DAWNLIKE_ROOT, sub);
  if (!fs.existsSync(dir)) {
    console.warn(`[contact] skip missing dir: ${sub}`);
    continue;
  }
  for (const file of fs.readdirSync(dir).filter(n => /0\.png$/.test(n)).sort()) {
    const rel = `${sub}/${file}`;
    const png = readSheet(rel);
    const { cols, rows } = gridOf(png);
    const base = sheetBase(rel);
    const big = drawGrid(upscale(png, SCALE));
    const outName = `${base}.png`;
    fs.writeFileSync(path.join(OUT, outName), PNG.sync.write(big));
    sections.push({ rel, base, cols, rows, outName, w: png.width * SCALE });
    console.log(`[contact] ${rel}  ${cols}x${rows} → contact/${outName}`);
  }
}

const html = `<!doctype html><meta charset=utf8><title>DawnLike contact sheets</title>
<style>
  body{background:#10131c;color:#d8d2bf;font:13px/1.4 system-ui,sans-serif;margin:24px}
  h2{margin:32px 0 8px;color:#e7c873}
  .sheet{position:relative;margin-bottom:8px;image-rendering:pixelated}
  .sheet img{display:block}
  .grid{position:absolute;top:0;left:0;display:grid;pointer-events:none}
  .cell{font:9px/1 monospace;color:#fff;text-shadow:0 0 2px #000,0 0 2px #000;padding:1px}
  .hint{color:#8a8674}
  code{color:#e7c873}
</style>
<h1>DawnLike contact sheets</h1>
<p class=hint>Each tile is labelled <code>col,row</code>. Record the ones you want in
<code>tools/dawnlike/picks.mjs</code>, then run <code>npm run build:dawnlike</code>.</p>
${sections
  .map(s => {
    const cells = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) cells.push(`<div class=cell>${c},${r}</div>`);
    return `<h2>${s.rel} <span class=hint>(${s.cols}×${s.rows})</span></h2>
<div class=sheet style="width:${s.w}px">
  <img src="${s.outName}" width="${s.w}">
  <div class=grid style="grid-template-columns:repeat(${s.cols},${TS}px);grid-template-rows:repeat(${s.rows},${TS}px)">${cells.join('')}</div>
</div>`;
  })
  .join('\n')}
`;
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`[contact] wrote contact/index.html (${sections.length} sheets) — open it in a browser to pick tiles.`);
