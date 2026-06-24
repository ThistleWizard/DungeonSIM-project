/**
 * lib.mjs — shared helpers for the DawnLike sprite pipeline (build-time only, never bundled).
 *
 * The pipeline turns the vendored DawnLike sheets (16x16 tile grids, gitignored under
 * `Sprites/`) into an M7 `SpritePack`. This module holds the bits both the contact-sheet
 * generator and the pack builder need: the sheet→archetype suggestions, the controlled-vocab
 * loader (single source of truth = `src/pack.ts`), and PNG crop/upscale/encode helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (tools/dawnlike → repo). */
export const REPO = path.resolve(HERE, '..', '..');
/** Vendored DawnLike root (gitignored build input). */
export const DAWNLIKE_ROOT = path.join(REPO, 'Sprites', 'Dawnhack Sprites', 'dawnlike-master');
/** Tile edge in source pixels. */
export const TILE = 16;

/**
 * Suggested archetype for each DawnLike Characters sheet (the §spec mapping table). This is a
 * DEFAULT the pick config can override per block — some archetypes (beast, vermin, fey,
 * construct, aberration) legitimately draw from more than one sheet, so the human picks which.
 */
export const SHEET_ARCHETYPE = {
  'Characters/Humanoid0.png': 'humanoid',
  'Characters/Player0.png': 'humanoid',
  'Characters/Undead0.png': 'undead',
  'Characters/Demon0.png': 'demon',
  'Characters/Reptile0.png': 'dragon',
  'Characters/Quadraped0.png': 'beast',
  'Characters/Cat0.png': 'beast',
  'Characters/Dog0.png': 'beast',
  'Characters/Rodent0.png': 'vermin',
  'Characters/Pest0.png': 'insectoid',
  'Characters/Slime0.png': 'ooze',
  'Characters/Elemental0.png': 'elemental',
  'Characters/Plant0.png': 'plant',
  'Characters/Misc0.png': 'aberration',
  'Characters/Aquatic0.png': 'aberration',
  'Characters/Avian0.png': 'beast',
};

/** Read `src/pack.ts` and extract the controlled vocab arrays — keeps one source of truth. */
export function loadVocab() {
  const src = fs.readFileSync(path.join(REPO, 'src', 'pack.ts'), 'utf8');
  const grab = name => {
    const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
    if (!m) throw new Error(`could not find ${name} in src/pack.ts`);
    return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1]);
  };
  return {
    archetypes: new Set(grab('ARCHETYPES')),
    sizes: new Set(grab('SIZES')),
    descriptors: new Set(grab('DESCRIPTORS')),
  };
}

/** Read a sheet PNG (relative to the DawnLike root) into a normalised RGBA bitmap. */
export function readSheet(relPath) {
  return PNG.sync.read(fs.readFileSync(path.join(DAWNLIKE_ROOT, relPath)));
}

/** Grid dimensions of a sheet, flooring any partial trailing row (e.g. Reptile0 = 15.5 → 15). */
export function gridOf(png) {
  return { cols: Math.floor(png.width / TILE), rows: Math.floor(png.height / TILE) };
}

/** Crop one 16x16 tile at [col,row] into its own PNG. */
export function cropTile(png, col, row) {
  const out = new PNG({ width: TILE, height: TILE });
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const si = ((row * TILE + y) * png.width + (col * TILE + x)) << 2;
      const di = (y * TILE + x) << 2;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

/** True when every pixel is fully transparent (a blank grid slot). */
export function isBlank(png) {
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] !== 0) return false;
  return true;
}

/** Nearest-neighbour upscale (preserves the pixel-art edges). */
export function upscale(png, scale) {
  const out = new PNG({ width: png.width * scale, height: png.height * scale });
  for (let y = 0; y < out.height; y++) {
    const sy = (y / scale) | 0;
    for (let x = 0; x < out.width; x++) {
      const sx = (x / scale) | 0;
      const si = (sy * png.width + sx) << 2;
      const di = (y * out.width + x) << 2;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

/** Encode a PNG to a self-contained `data:` URI (what `SpriteEntry.src` carries). */
export function pngToDataURI(png) {
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

/** Base filename without extension, e.g. "Characters/Undead0.png" → "undead0". */
export function sheetBase(relPath) {
  return path.basename(relPath, '.png').toLowerCase();
}
