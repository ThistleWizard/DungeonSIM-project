# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**DungeonState** — Phase 2 of an LLM-powered open-ended dungeon crawl that runs inside
SillyTavern. The project is currently in the **design/handoff stage**: there is no
application source code yet, only design artifacts and a vendored reference library.
The job is to build the script described in `DungeonState-Design.md`.

The founding principle (drives every decision below): **the LLM narrates and adjudicates;
it does not remember.** Phase 1 held all game state in re-emitted prose (a full
`<dungeon_state>` ledger every turn) and drifts on long runs. Phase 2 moves state into
real, persisted, Zod-validated variables, with the model emitting only small *mutations*.

## Repository layout

The actual project files live at the repo root:

- `DungeonState-Design.md` — **the spec.** Read this first. Architecture, schema design,
  invariants, and the M1–M7 build milestones. Section references (§5, §10, etc.) below
  point into it.
- `dungeon-schema.zod.ts` — first-draft Zod schema for the chat-scope state tree (M1).
- `extract-commands.spec.md` — behavioural contract + test cases for the command parser
  (M2). Build the parser test-first against these (R1–R11).
- `DungeonSIM.json` — the working Phase-1 SillyTavern preset (v0.1.2). OpenAI-style
  preset JSON; reference for the existing game's prompt logic, not code to edit casually.
- `JS-Slash-Runner-main/` — **vendored reference copy of Tavern Helper** (the runtime this
  script targets). See below.

## Architecture (the big picture)

The system has three layers; the script you build is the middle one:

1. **SillyTavern preset** (`DungeonSIM.json`, evolved): narration, adjudication, and the
   command grammar. Emits prose + an `<UpdateDungeon>` mutation block each turn.
2. **DungeonState script** (Tavern Helper script scope) — the thing being built:
   - On `GENERATION_ENDED` / `MESSAGE_RECEIVED`: `extractCommands(text)` → validate against
     schema + old-value check → `updateVariablesWith(applier, {type:'chat'})` → snapshot to
     `message` scope for rewind safety → build `delta_log`.
   - On `GENERATION_STARTED` (prompt assembly): inject a **compact** authoritative state
     block (current room + exits + sheet + inventory + active combat), **not** the whole tree.
3. **Tavern Helper variable store** — the canonical persisted dungeon state.

**Division of labour:** the model decides *what happens* and *which* mutations to emit; the
script *computes and enforces* — arithmetic (HP −= dmg), threshold checks, and the
invariants below. `{{roll:NdN}}` RNG stays in the preset; the script does not roll.

### State storage model

State is stored in Tavern Helper **chat-scope** variables, namespaced under a single
`dungeon` key (e.g. `dungeon.player.hp.cur`) to avoid colliding with other extensions.
Mutation-command paths are relative to `dungeon.` and the applier prepends it. The room map
is a graph stored directly as nested objects (`dungeon.rooms.R03.exits.north = {...}`).

### Invariants the applier MUST enforce (§5 — the whole point of Phase 2)

1. **Topology lock** on `rooms.*.exits.*`: may add an exit to a new direction or change its
   `state`; may never delete an exit or redirect `to` (except a secret-reveal flag or an
   explicit destruction command). Reciprocal edges auto-maintained.
2. **Inventory legality**: remove/decrement only if present in sufficient qty; equip only if owned.
3. **Numeric bounds**: clamp `hp.cur` to `[0, hp.max]`; the script rolls skill marks into
   rank-ups (compute, don't trust the model).
4. **Old-value confirmation**: a `set`'s declared old value is compared to stored; mismatch
   is logged as desync (apply new value but flag it — visible, never silent).
5. **Append-only** rooms/bestiary except whitelisted mutable subfields.

On any failed invariant or illegal path: do not apply, push `[BLOCKED] …` to `delta_log` and
`console.warn`. Never corrupt the tree, never throw out of the parser.

## Critical constraints

- **Do NOT install or depend on MVU / MagVarUpdate** (`MagicalAstrogy/MagVarUpdate`). Its
  shipped code contains base64-obfuscated jailbreak prompts (`src/prompts/*.txt`, wired in
  via `src/function/update/invoke_extra_model.ts`). We **reimplement** its good design ideas
  (mutation syntax, paren-counting extractor, dual stat/display data) on top of Tavern
  Helper directly. Mining MVU's parser design for reference is fine; importing/running it is not.
- **Build on Tavern Helper's variable API — don't write a persistence/path/merge layer.**
  Use the primitives in `JS-Slash-Runner-main/.../src/function/variables.ts`:
  `getVariables`, `replaceVariables`, `updateVariablesWith` (main entry point),
  `insertOrAssignVariables`, `insertVariables`, `deleteVariable`, `registerVariableSchema`.
- The **command parser is a pure function** (no SillyTavern dependency) — build and unit-test
  it in isolation per `extract-commands.spec.md`. The paren-counting state machine (so inner
  `);` inside string args don't terminate a call) is the one genuinely fiddly bit; get R3 right.

## Tooling

The DungeonState project (repo root) is a TypeScript project with Vitest + Prettier:

```bash
npm install
npm test                     # vitest run (all tests in tests/)
npm run test:watch           # vitest watch
npx vitest run -t "R3"       # run a single test by name substring
npm run typecheck            # tsc --noEmit
npm run build                # tsc → dist/
npm run format               # prettier --write
```

`src/parser.ts` is a **pure function** with no SillyTavern dependency — it and the schema
run fully under Vitest. The applier, event wiring, and prompt injection (M3+) will need ST
globals (`getVariables`, `updateVariablesWith`, etc.); stub or inject those for unit tests
rather than importing the runtime.

Value parsing in the parser layers JSON → number → **JSON5** → YAML → raw string. JSON5 is
what makes R4 work: plain YAML silently mis-parses compact object literals like `{id:'x'}`
(it reads the whole thing as a key). Keep JSON5 ahead of YAML.

`JS-Slash-Runner-main/JS-Slash-Runner-main/` is the vendored reference copy of Tavern Helper
(gitignored, reference only — not built or tested here). Its own toolchain uses pnpm
(`pnpm install && pnpm build`).

### Where to look in the reference library

- `src/function/variables.ts` — the API we build on (read `updateVariablesWith`,
  `registerVariableSchema`, the `VariableOption` union, and the swipe-id-indexed `message`
  scope used for rewind/branching).
- `src/function/index.ts` — confirms what's exported to scripts.
- Tavern Helper exposes `z` (Zod) and lodash `_` as globals via auto-imports; the schema file
  relies on this. When unit-testing outside ST, `import { z } from 'zod'` instead.

## Build order

Follow the milestones in `DungeonState-Design.md` §8: **M1** schema + chargen seeding →
**M2** parser (`extractCommands`) → **M3** applier + invariants (this is the milestone that
kills drift) → **M4** preset surgery (full-ledger → `<UpdateDungeon>` mutations) →
**M5** rewind safety (message-scope snapshots) → **M6** SVG map render → **M7** sprite
seed-locking. Prove linear-play state persistence (through M3) before rewind, combat math, or
the TTRPG depth layer (§13).

### Status & module map

- **M1 done** — `src/schema.ts` (`DungeonSchema`, `emptyDungeon`, `ROOT_KEY`).
- **M2 done** — `src/parser.ts` (`extractCommands`), `src/types.ts` (`Command`).
- **M3 done** — `src/applier.ts` (`applyCommands`, pure) + `src/store.ts`
  (`processMessage`, `makeStore`, behind an injectable `VariableStore`).
- **Next: M4** — fork the preset to emit `<UpdateDungeon>` mutations instead of the full
  ledger, and add the compact state-injection block (design §6). Then **M5** rewind safety.

The applier is the pure core: `applyCommands(dungeon, commands)` deep-clones its input,
enforces the five §5 invariants, and returns `{ dungeon, delta_log, blocked, desync }`.
Blocked invariants and old-value desyncs are pushed to `delta_log` (prefixed `[BLOCKED]` /
`[DESYNC]`) and to an injectable `warn` logger; the tree is never corrupted and nothing throws.
Runtime glue (event hooks reading/writing chat-scope vars) builds a `VariableStore` from
`getVariables`/`replaceVariables` and calls `processMessage` — see the snippet at the top of
`src/store.ts`. `move` is parsed but intentionally blocked at apply time (underspecified).
