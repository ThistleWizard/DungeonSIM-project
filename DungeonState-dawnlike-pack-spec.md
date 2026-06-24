# Spec — DawnLike slice-tool → drop-in M7 sprite pack

**Status:** spec only (next work item after `m7-sprites` is live-verified). Not built.
**Goal:** turn the vendored DawnLike tileset into a real M7 sprite pack with **minimal effort and
zero runtime-model change**, so we can see the real look in-game cheaply — and bail cheaply if we
don't like it. Lean on purpose (user: "don't overwork in case I ultimately don't like the look").

## Why this is low-risk
The M7 pack layer is already **pack-agnostic**: the resolver (`src/sprites.ts`) and DOM filler
(`fillSprites`) only know `SpriteEntry { id, tags, src }` and `SpritePack`. So a new pack is a new
module of the same shape — **no engine, resolver, runtime, or display changes**, just a different
`pack` passed at bootstrap. The only work is producing that module from DawnLike.

## The one real problem: sheets, not sprites
DawnLike `Characters/*.png` are **sprite *sheets*** — grids of 16×16 tiles (e.g. `Undead0.png` is
128×160 = 8 cols × 10 rows ≈ 80 tiles; skeletons/zombies/ghosts/liches in color variants). Our
model wants **one image per sprite** (`SpriteEntry.src` = a single image). So we **slice**: a
build-time tool crops the chosen tiles and emits each as its own PNG data-URI.

**Why slice (option A) not sheet+coords (option B):** keeps `SpriteEntry.src` a single image →
`fillSprites` and the pack model are untouched; the pack stays self-contained (inline data-URIs),
so no asset hosting / no path resolution inside the ST iframe. 16×16 PNGs are tiny (~hundreds of
bytes each); even ~80–120 tiles is a small module. Accept a soft budget (see Risks).

## Source facts (verified)
- Location: `Sprites/Dawnhack Sprites/dawnlike-master/`.
- License: **CC-BY-SA 3.0** — redistributable (unlike Gold Box rips). Must credit **DragonDePlatino**
  + **DawnBringer** (palette); share-alike applies to the *art* (the generated pack module carries a
  CC-BY-SA header; our other code keeps its own license). Mandatory easter egg: hide the Platino
  sprite (in `Reptile*.png`) somewhere — track as a fun TODO.
- Tiles: 16×16, transparent PNGs (assumed — **verify alpha at build time**; if keyed, the tool must
  color-key the background out).
- Each creature has a 2-frame animation: the `0`/`1` filename suffix. **v1 uses frame `0` only.**

## The tool — `tools/build-dawnlike-pack.mjs`
Config-driven so adding/retuning tiles is data, not code, and so the SAME tool can later produce
item/portrait packs (see Future hooks):

```
// config entry shape (one per output pack)
{
  packId: 'dawnlike-characters',
  root: 'Sprites/Dawnhack Sprites/dawnlike-master',
  tileSize: 16,
  out: 'src/packs/dawnlike.ts',
  entries: [
    // archetype -> a sheet + the tiles to draw from. id is generated; tags drive the resolver.
    { sheet: 'Characters/Undead0.png', tiles: [[col,row], ...], tags: ['undead'] },
    { sheet: 'Characters/Undead0.png', tiles: [[col,row]],      tags: ['undead','skeletal'] },
    ...
  ]
}
```

Pipeline: read PNG → for each `[col,row]` crop the 16×16 region → re-encode as PNG → base64
data-URI → push `{ id: '<sheetbase>_<col>_<row>', tags, src }`. Emit `src/packs/dawnlike.ts`
exporting a `SpritePack` (`sprites[]` + `categoryGenerics` = first tile per archetype). Pure JS PNG
crop via **`pngjs`** (pure-JS, no native build; dev dependency only) — read RGBA, copy sub-rect,
write. Do **not** rescale (leave native 16×16; the viewport already upscales with
`image-rendering:pixelated`).

Optional helper (small, build it only if picking coords by eye is annoying): a `--contact-sheet`
mode that writes each sheet with a col/row index overlay, so choosing tile coords is quick.

## Tag → sheet mapping (the only judgement work)
The resolver picks within a candidate set by tags + `hashId`, so we need **"archetype → a set of
tiles,"** not per-tile naming. DawnLike's category sheets line up almost 1:1 with our 13 archetypes:

| our archetype | DawnLike sheet(s) |
|---|---|
| humanoid | Humanoid0 (+ Player0 for variety) |
| undead | Undead0 |
| demon | Demon0 |
| dragon | Reptile0 |
| beast | Quadraped0, Cat0, Dog0 |
| vermin | Rodent0, Pest0 |
| insectoid | Pest0 |
| ooze | Slime0 |
| elemental | Elemental0 |
| plant | Plant0 |
| aberration | Misc0 / Aquatic0 (pick the eldritch-looking ones) |
| fey | Humanoid0 (recolors) / Misc0 |
| construct | Misc0 (pick golems/statues) |

For each: pick **2–6 tiles** for per-instance variety, plus a few **descriptor-tagged** ones where
the sheet obviously supports it (`skeletal` from Undead0, `armored`/`robed` from Humanoid0,
`winged`/`scaled` from Reptile0). Picking the coords is a one-time eyeball pass (I can view the
sheets and record them when we build).

## Integration (one line)
At runtime bootstrap (`src/runtime.ts` / `bootstrapDisplay`), pass `dawnlikePack` instead of
`DEFAULT_PACK`. Keep `DEFAULT_PACK` (the SVG silhouettes) as the fallback. Optionally make it
selectable later (a `/spritepack` toggle); **compile-time swap for v1.**

## Deliverables
- `tools/build-dawnlike-pack.mjs` (+ its config; `pngjs` dev dep).
- `src/packs/dawnlike.ts` (generated, CC-BY-SA header).
- One-line pack swap at bootstrap; `DEFAULT_PACK` stays as fallback.
- `CREDITS.md` entry (DawnLike CC-BY-SA, DragonDePlatino + DawnBringer) + the Platino easter-egg TODO.
- A couple of sanity tests against the new pack: every archetype resolves to a `pack:` ref; ids
  unique; `spriteRefToSrc` returns a data-URI.

## Non-goals (v1 — keep it lean)
- No 2-frame animation (ignore the `_1` sheets).
- No `Objects/` scene-background tiles, no player sprite, no gen-fallback change.
- No item/portrait packs yet (but the tool is built general enough to add them as configs).

## Future hooks (design for, don't build) — the reason DawnLike is worth adopting
The same config-driven tool extends to the user's downstream wants:
- **Items → inventory sprites:** `Items/*.png` (Potion, Scroll, Key, LongWep, Money, Light…). A
  second config maps item `kind`/name → tile; the inventory renderer (`sheet.ts`/display) keys rows
  to sprites later.
- **Portraits / dialogue mode:** `Commissions/*.png` (class portraits) + `Characters` for NPC faces
  → a portrait pack feeding a future player-portrait slot or an NPC dialogue UI.
Keep the tool's config schema generic (`{sheet, tileSize, tiles:[{col,row,id,tags}], packId, out}`)
so Characters / Items / Portraits are all just different configs against one tool.

## Risks / decisions to settle when building
- **Transparency:** confirm tiles are alpha-transparent; add color-keying only if needed.
- **Bundle size:** count chosen tiles; keep the data-URI total modest (soft budget; revisit if it
  bloats `dist/dungeonstate.js` noticeably — fallback is option B, sheet+coords, which stores one
  data-URI per sheet instead of per tile).
- **Tile-selection effort:** the contact-sheet helper is the lever if eyeballing coords is slow.
- **Pack selection:** compile-time swap now; a runtime toggle only if we keep both packs long-term.
