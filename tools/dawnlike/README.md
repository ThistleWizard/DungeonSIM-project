# DawnLike sprite pipeline

Turns the vendored **DawnLike** tileset (16×16 sheets under `Sprites/Dawnhack Sprites/dawnlike-master/`,
gitignored) into the M7 sprite pack — a generated `SpritePack` the runtime drops in with no engine
change. You **slice + tag by hand** in one config; the build does the rest.

```
contact sheets ──▶ you pick + tag in picks.mjs ──▶ build ──▶ manifest.json + dawnlike.ts
```

No API key, no model. The automation is the slicing, the searchable manifest, and the build.

## Files

| File | What it is |
|---|---|
| `contact.mjs` | Generates contact sheets (`contact/index.html`) so picking tile coordinates is fast. |
| `picks.mjs` | **The one file you edit** — your chosen tiles + their tags. |
| `build-pack.mjs` | Slices the picked tiles, validates tags, writes the manifest + pack module. |
| `lib.mjs` | Shared helpers (PNG crop/upscale, vocab loader). Don't need to touch. |
| `contact/` | Generated contact sheets (gitignored). |

Outputs (committed): `src/packs/dawnlike.manifest.json` (the searchable schema) and
`src/packs/dawnlike.ts` (the generated pack).

## The tag set

These are the **only** valid values — they come from `src/pack.ts`, and the build **fails** on
anything else (so typos can't ship).

- **Archetype** — set **once per sheet** (the high-weight match tag):
  `humanoid · beast · undead · construct · ooze · dragon · insectoid · demon · elemental · plant · vermin · aberration · fey`
- **Size** — per tile: `tiny · small · medium · large · huge`
- **Descriptors** — per tile, 0–3: `armored · winged · horned · robed · skeletal · fanged · tentacled · fiery · icy · spectral · aquatic · clawed · scaled · furred · multi_eyed`

## Step by step

1. **Generate contact sheets** (defaults to Characters):
   ```
   npm run dawnlike:contact            # or: node tools/dawnlike/contact.mjs Items Objects Commissions
   ```
   Open `tools/dawnlike/contact/index.html` in a browser. Every tile is labelled `col,row`.

2. **Edit `picks.mjs`.** Find (or add) the block for a sheet. Set its `category` and — for
   characters — its `archetype` (one of the list above). **Do not repeat archetype per tile**;
   the build prepends it automatically as the first tag.

3. **Add a line per tile you want:**
   ```js
   { col: 3, row: 2, tags: ['skeletal', 'armored'], size: 'medium', name: 'skeleton warrior' }
   ```
   - `tags` — only **descriptors** that clearly apply. None? `tags: []`.
   - `size` — your read of scale (most humanoids `medium`, rats `small`, dragons `large`/`huge`).
   - `name` — free text, for the searchable manifest only (not used for matching).

4. **Pick ≥2 tiles per archetype** so same-type mobs get visual variety (the resolver ties-break
   by mob id). Add descriptor-tagged variants where the sheet supports it (skeletal from Undead0,
   armored/robed from Humanoid0, winged/scaled from Reptile0).

5. **Build:**
   ```
   npm run build:dawnlike
   ```
   Off-vocab tag/size or a bad coordinate **fails** the build with the offending entry. Thin
   archetype coverage and blank tiles just **warn** (so you can author incrementally).

6. **Review** `src/packs/dawnlike.manifest.json` (it's plain JSON — grep/jq it, or eyeball it).
   Tweak `picks.mjs`, rebuild. Run `npm test` — `tests/dawnlike.test.ts` checks the pack stays
   well-formed.

## How matching works (so you don't over-tag)

Archetype carries the match (**weight 10**); descriptors only nudge **within** an archetype (an
`armored` humanoid beats a plain one); size is a weak tie-breaker. So a clean archetype + one good
descriptor beats five fuzzy ones. Unknown tags simply don't match — they never break anything.

## Going live

The runtime still ships the built-in SVG silhouettes (`DEFAULT_PACK`). Once Characters coverage is
reasonably complete (ideally all 13 archetypes — the build warns about gaps), flip the pack in
`src/runtime.ts`: replace the two `DEFAULT_PACK` references in `bootstrap()`
(the `createRuntime({ pack: ... })` arg and the `bootstrapDisplay(store, ..., warn)` arg) with
`dawnlikeCharacterPack` (imported from `./packs/dawnlike.js`), then `npm run build:script`.

## Items / Objects / Portraits

Run `dawnlike:contact Items Objects Commissions` and add blocks with `category: 'item' | 'object'
| 'portrait'` and a `kind` label (no archetype). They land in the manifest as a tagged catalogue
for future inventory/portrait work — **not** wired to the mob resolver yet.

## Deferred: LLM auto-tagging

If we ever auto-curate the *bulk* library (keep every non-blank tile, hundreds of them), a Haiku
vision pass becomes worth it. Spec lives in `DungeonState-dawnlike-pack-spec.md` and the plan;
not built — at this scale hand-tagging in `picks.mjs` is faster and more accurate.

## License

DawnLike is **CC-BY-SA 3.0**. The generated `dawnlike.ts` and `dawnlike-*.ts` carry the art and so
inherit CC-BY-SA 3.0. See `CREDITS.md` at the repo root.
