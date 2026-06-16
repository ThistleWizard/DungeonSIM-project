# DungeonState

A deterministic, schema-validated **state engine** for DungeonSIM — an LLM-powered
open-ended dungeon crawl that runs inside [SillyTavern](https://github.com/SillyTavern/SillyTavern)
via the **Tavern Helper** (JS-Slash-Runner) extension.

**Founding principle: the LLM narrates and adjudicates; it does not remember.** Phase 1 kept
all game state in re-emitted prose (a full `<dungeon_state>` ledger every turn) and drifted on
long runs. Phase 2 moves state into real, persisted, Zod-validated variables — the model emits
only small *mutations* (`<UpdateDungeon>` blocks), and the script computes and enforces the
rest (arithmetic, bounds, map topology, inventory legality).

## How it works

Three layers; the script in this repo is the middle one:

1. **Preset** (`DungeonSIM-Phase2.json`) — narration + adjudication; reads an injected
   `[CURRENT STATE]` block and emits an `<UpdateDungeon>` mutation block each turn.
2. **DungeonState script** (this repo) — parses the mutations, enforces the invariants,
   applies them to Tavern Helper variables, snapshots state per message for rewind safety, and
   injects the compact `[CURRENT STATE]` block back into the prompt.
3. **Tavern Helper variable store** — the canonical persisted dungeon (chat scope), with
   swipe-indexed snapshots (message scope) so state follows the timeline.

## Quick start

```bash
npm install
npm run build:script      # → dist/dungeonstate.js  (single loadable file)
```

Then load `dist/dungeonstate.js` into Tavern Helper and import the Phase-2 preset — see
**[LOADING.md](./LOADING.md)** for the full play/verify walkthrough. Rewind (swipe / regenerate
/ delete) is supported.

## Status

| Milestone | What | State |
|---|---|---|
| M1 | Schema + chargen seeding (`src/schema.ts`) | done |
| M2 | Command parser (`src/parser.ts`) | done |
| M3 | Applier + §5 invariants (`src/applier.ts`, `src/store.ts`) | done |
| M4 | Preset surgery → `<UpdateDungeon>` mutations | done |
| M4.5 | Runtime bridge + bundler (`src/runtime.ts`, `tools/build-script.mjs`) | done |
| M5 | Rewind safety: message-scope snapshots (`src/rewind.ts`) | done |
| M6 | SVG map render from the `rooms` graph | next |
| M7 | Sprite seed-locking | planned |

## Development

```bash
npm test                 # vitest run (all tests in tests/)
npm run test:watch       # vitest watch
npm run typecheck        # tsc --noEmit
npm run format           # prettier --write
npm run build:script     # bundle the loadable script
```

The core is built as pure, dependency-injected functions (parser, applier, store pipeline,
rewind) and is fully unit-tested without SillyTavern; only `src/runtime.ts`'s bootstrap touches
ST globals, and it self-guards so the suite runs under plain Node.

## Repository layout

- **`DungeonState-Design.md`** — the spec (architecture, schema, invariants, milestones).
- **`CLAUDE.md`** — working notes / module map / build order for contributors.
- **`LOADING.md`** — how to build, load into Tavern Helper, and play/verify.
- `src/` — the script (schema, parser, applier, store, inject, rewind, runtime).
- `tools/` — the esbuild bundler and the Phase-2 preset generator.
- `JS-Slash-Runner-main/` — vendored reference copy of Tavern Helper (reference only).
