/**
 * picks.mjs — the ONE file you hand-edit. Curation + tags for the DawnLike pack.
 *
 * Workflow (see README.md):
 *   1. `npm run dawnlike:contact` → open tools/dawnlike/contact/index.html
 *   2. add tiles below: per sheet set `archetype` (characters) once; per tile give col,row,
 *      tags (descriptors only), size, name
 *   3. `npm run build:dawnlike`  → src/packs/dawnlike.manifest.json + src/packs/dawnlike.ts
 *
 * Valid tag values are the controlled vocab in src/pack.ts (the build fails on anything else):
 *   ARCHETYPE (per sheet): humanoid beast undead construct ooze dragon insectoid demon
 *                          elemental plant vermin aberration fey
 *   SIZE (per tile):       tiny small medium large huge
 *   DESCRIPTORS (per tile, 0-3): armored winged horned robed skeletal fanged tentacled fiery
 *                          icy spectral aquatic clawed scaled furred multi_eyed
 *
 * Rules of thumb:
 *   - archetype carries the match (weight 10); descriptors only refine WITHIN an archetype;
 *     size is a weak tie-breaker. Don't over-tag.
 *   - pick >=2 tiles per archetype so same-type mobs get visual variety.
 *   - `name` is for the searchable manifest only (not used for matching).
 *
 * @typedef {{col:number,row:number,tags?:string[],size?:string,name?:string}} Tile
 * @typedef {{sheet:string,category:'character'|'item'|'object'|'portrait',archetype?:string,kind?:string,tiles:Tile[]}} Pick
 * @type {Pick[]}
 */
export default [
  // ── Characters → mob sprites (wired to the runtime resolver) ──────────────────────────────
  // Each archetype needs >=2 tiles. Fill these from the contact sheet. Examples seeded below;
  // VERIFY coordinates against contact/index.html and expand.

  { sheet: 'Characters/Humanoid0.png', category: 'character', archetype: 'humanoid', tiles: [] },

  // SEEDED EXAMPLE (verify against contact/index.html): undead from Undead0.
  { sheet: 'Characters/Undead0.png', category: 'character', archetype: 'undead', tiles: [
    { col: 0, row: 0, tags: [], size: 'medium', name: 'zombie' },
    { col: 4, row: 0, tags: [], size: 'medium', name: 'zombie' },
    { col: 0, row: 2, tags: ['robed'], size: 'medium', name: 'robed lich' },
    { col: 6, row: 2, tags: ['robed'], size: 'medium', name: 'crowned lich' },
    { col: 0, row: 4, tags: ['spectral'], size: 'medium', name: 'ghost' },
    { col: 3, row: 4, tags: ['spectral'], size: 'medium', name: 'shadow' },
  ] },

  { sheet: 'Characters/Demon0.png', category: 'character', archetype: 'demon', tiles: [] },
  { sheet: 'Characters/Reptile0.png', category: 'character', archetype: 'dragon', tiles: [] },
  { sheet: 'Characters/Quadraped0.png', category: 'character', archetype: 'beast', tiles: [] },

  // SEEDED EXAMPLE: vermin from Rodent0.
  { sheet: 'Characters/Rodent0.png', category: 'character', archetype: 'vermin', tiles: [
    { col: 0, row: 0, tags: ['furred'], size: 'small', name: 'rat' },
    { col: 4, row: 0, tags: ['furred'], size: 'small', name: 'rat' },
    { col: 3, row: 0, tags: ['icy', 'furred'], size: 'small', name: 'frost rat' },
  ] },

  { sheet: 'Characters/Pest0.png', category: 'character', archetype: 'insectoid', tiles: [] },

  // SEEDED EXAMPLE: ooze from Slime0.
  { sheet: 'Characters/Slime0.png', category: 'character', archetype: 'ooze', tiles: [
    { col: 0, row: 0, tags: [], size: 'medium', name: 'green ooze' },
    { col: 3, row: 0, tags: [], size: 'medium', name: 'ooze' },
    { col: 4, row: 0, tags: ['fiery'], size: 'medium', name: 'magma ooze' },
    { col: 0, row: 3, tags: [], size: 'small', name: 'slime' },
    { col: 2, row: 3, tags: ['fiery'], size: 'small', name: 'fire slime' },
  ] },
  { sheet: 'Characters/Elemental0.png', category: 'character', archetype: 'elemental', tiles: [] },
  { sheet: 'Characters/Plant0.png', category: 'character', archetype: 'plant', tiles: [] },
  { sheet: 'Characters/Misc0.png', category: 'character', archetype: 'construct', tiles: [] },
  { sheet: 'Characters/Aquatic0.png', category: 'character', archetype: 'aberration', tiles: [] },
  // `fey` has no dedicated sheet — draw a couple of recolour-friendly humanoid tiles for it.
  { sheet: 'Characters/Humanoid0.png', category: 'character', archetype: 'fey', tiles: [] },

  // ── Items / Objects / Portraits → tagged catalogue only (not matched yet). Fill later. ────
];
