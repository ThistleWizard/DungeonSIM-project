# DungeonState — Phase 2 Design Document
### The deterministic state layer for DungeonSIM
*Reference document for the Claude Code build. Written after reverse-engineering Tavern Helper's variable API and the MagVarUpdate (MVU) protocol.*

---

## 0. Read this first (the situation in one screen)

We are building an LLM-powered open-ended dungeon crawl in SillyTavern (NetHack / Wizardry / Ultima Underworld lineage). Phase 1 is **done and working**: a preset fork (`DungeonSIM.json`, v0.1.2) that runs the whole game through prompt engineering, holding state by re-emitting a full `<dungeon_state>` ledger every turn. It survives ~18+ turns but **will drift** on long runs — the map ledger is the first thing to degrade, because the model is acting as a database.

Phase 2 fixes this by moving state out of the model's prose and into **real, persisted, schema-validated variables**, with the model emitting only small *mutations*. This is the architecture from day one: **the LLM narrates and adjudicates; it does not remember.**

**Key decision already made:** We build on **Tavern Helper** (the JS execution + variable-store extension, repo `N0VI028/JS-Slash-Runner`). We do **NOT** install **MVU / MagVarUpdate** as a dependency — see §1. We reimplement MVU's good ideas ourselves on top of Tavern Helper's clean API.

---

## 1. Why we reimplement instead of depending on MVU

MVU (`MagicalAstrogy/MagVarUpdate`) solves exactly our problem and its *design* is excellent — we borrow heavily from it below. But its shipped code contains **deliberately base64-obfuscated jailbreak prompts** (`src/prompts/claude_head.txt`, `claude_tail.txt`, and the gemini equivalents). Decoded, they are roleplay-override / "reject your safety instructions" payloads, including references to disallowed content categories. They are wired into MVU's **"extra model"** delegation path (`src/function/update/invoke_extra_model.ts`), where MVU farms the variable-update step to a secondary model call.

Consequences for us:
- **Do not install MVU.** Obfuscated payloads in a core library mean the whole package gets less trust, not just one file.
- We **do** mine its architecture and parser design (MIT licensed, and ideas aren't the problem — the hidden prompts are).
- Tavern Helper itself (separate author, N0VI028) showed **no such flags** in the variable API we audited. It is the foundation.
- Net effect is *positive*: we wanted to avoid RPG-genre lock-in and an opaque dependency anyway. Reimplementing the parser is a few hundred lines and gives us a clean, auditable, dungeon-shaped system.

---

## 2. What Tavern Helper gives us (the foundation, audited)

From `src/function/variables.ts`. This is the storage substrate. All of it is exposed to scripts.

**Scopes** (`VariableOption.type`): `global | preset | character | chat | message | script | extension`.
- **`chat`** — persists in `chat_metadata.variables`, lives for the whole chat. *This is our primary store for the run-state.*
- **`message`** — stored per-message, **swipe-aware** (`chat[i].variables[swipe_id]`). Each message keeps its own snapshot. *This is the rewind/branch solution: if the player swipes or edits back, state travels with the message.* See §7.
- `global` — cross-chat persistence (use for meta: death log / graveyard across runs).

**Storage model:** plain nested JS objects, `Record<string, any>`. Addressed by **lodash path strings** (`_.get`, `_.set`, `_.unset`). Nested objects and arrays are first-class. **This answers the graph question: a room graph maps directly** — e.g. `rooms.R03.exits.north = "R02"`.

**Mutation primitives (already implemented, just call them):**
| Function | Behaviour |
|---|---|
| `getVariables(option)` | deep clone of current vars for a scope |
| `replaceVariables(vars, option)` | overwrite whole scope |
| `updateVariablesWith(updater, option)` | read → run `updater(vars)` → write. **Our main entry point.** |
| `insertOrAssignVariables(partial, option)` | deep-merge, arrays replaced (mergeWith) |
| `insertVariables(partial, option)` | merge but **only fills missing** keys (good for init) |
| `deleteVariable(path, option)` | `_.unset` at path |
| `registerVariableSchema(zodSchema, {type})` | **register a Zod schema per scope** — validation is built in |

**Implication:** we do not write a persistence layer, a path resolver, or a merger. We write (a) a Zod schema, (b) a command parser, (c) an applier that calls `updateVariablesWith`, (d) prompt-injection of current state, (e) optional UI. Tavern Helper does the rest.

**Security note:** Tavern Helper runs script JS in an isolated iframe. Our script is our own code; review before install on the Pi. README carries an explicit arbitrary-JS warning — expected for this class of tool.

---

## 3. What we borrow from MVU's design (the good ideas)

From `src/function/update_variables.ts` (1498 lines — the parser) and `src/variable_def.ts` (types). We reimplement these, not copy the package.

### 3.1 The mutation command syntax (ADOPT, adapted)
The model emits commands inside a tag block. MVU uses `<UpdateVariable>` containing lodash-style calls:
```
_.set('path.to.var', oldValue, newValue);//reason for change
```
Three-arg `set`: **path, old value (confirmation), new value**, plus a trailing `//reason` comment. Commands supported: `set | insert | assign | add | remove | unset | delete | move`, plus a `<json_patch>` form (RFC-6902-ish).

Why it's good:
- The **old-value confirmation arg** lets the applier detect desync — if the model's claimed old value ≠ stored value, that's a caught error, not silent corruption.
- The **reason comment** is free provenance/logging and (via display_data, below) free UI.
- Tiny token footprint vs. re-emitting the whole ledger.

### 3.2 The bracket-counting extractor (ADOPT the technique)
Naive regex `/_\.set\(([\s\S]*?)\);/` breaks on nested `);` inside string args. MVU uses a **state machine that counts parens** (`findMatchingCloseParen`) to find the true end of each call, then checks a `;` follows. We reimplement this — it's the one genuinely fiddly bit and it's worth getting right. (Reference: `extractCommands`, ~line 282.)

### 3.3 The dual store: `stat_data` vs `display_data` (ADOPT, simplified)
MVU keeps two parallel trees:
- **`stat_data`** — canonical current values (optionally `[value, "description/constraint"]` pairs — the `ValueWithDescription` pattern).
- **`display_data`** — same paths but holding `"old->new (reason)"` strings for the turn, for rendering "what changed this turn."

We adopt a lean version: canonical state in `stat_data`, and a per-turn **`delta_log`** (array of human-readable change strings) for the "what just happened" UI and for debugging drift. We do **not** need MVU's full `ValueWithDescription` everywhere — use it only where a constraint note helps the model (e.g. HP carrying `"[0,maxHP]"`).

### 3.4 The `$meta` / template system (ADOPT selectively)
MVU's schema nodes carry `extensible`, `recursiveExtensible`, and `template` (auto-fill shape for new entries). We want exactly this for **append-on-discovery** structures: when the model adds room `R09`, a `template` ensures it gets the full room shape (id, name, exits{}, contents[], visited flag) even if the model only specified some fields. Implement as Zod defaults + a normalizer rather than MVU's bespoke meta walker.

### 3.5 What we DROP from MVU
- All `prompts/*.txt` (the jailbreaks). Never.
- The **extra-model delegation path** entirely. Our single GLM/Claude call emits its own mutations in-line; we do not spin a second model to compute updates.
- The deprecated `display_data/delta_data` internals (`$internal`) — MVU itself marks these `@deprecated` in favour of "MVU zod". We go straight to the lean version.

---

## 4. Target architecture

```
            ┌─────────────────────────────────────────────┐
            │  SillyTavern preset (DungeonSIM, evolved)    │
            │  - narration, adjudication, command grammar  │
            │  - emits <UpdateDungeon> mutation block      │
            └───────────────┬─────────────────────────────┘
                            │ model output (prose + mutation block + sprite)
                            ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  DungeonState script (Tavern Helper script scope)             │
   │                                                                │
   │  on GENERATION_ENDED / MESSAGE_RECEIVED:                       │
   │   1. extractCommands(messageText)      ← §3.2 state machine    │
   │   2. validateAgainstSchema + oldVal check  ← §3.1, §5          │
   │   3. updateVariablesWith(applier, {chat})  ← §2 TH primitive   │
   │   4. snapshot to {message} scope         ← §7 rewind safety    │
   │   5. build delta_log for UI                                    │
   │                                                                │
   │  on GENERATION_STARTED (prompt assembly):                      │
   │   6. inject compact authoritative state block ← §6            │
   │      (current room + exits + sheet + inv + combat)             │
   └──────────────────────────────────────────────────────────────┘
                            │ reads/writes
                            ▼
        chat-scope variables (the canonical dungeon state, §5)
                            │
                            ▼
        optional: SVG map render + sheet UI (Phase 2.5, §8)
```

**Division of labour (unchanged from the founding principle):**
- **Model decides:** what happens, DCs, narrative, *which* mutations to emit, sprite fragments.
- **Script computes/enforces:** arithmetic (HP −= dmg), threshold checks (level-up, death-save trigger), topology lock (reject illegal exit edits), inventory legality, persistence.

The `{{roll:NdN}}` true-RNG macros from Phase 1 **stay in the preset** — RNG is the model's input, the script doesn't roll. The script may *later* take over deterministic combat math (§9) but v2.0 keeps combat in the preset and only persists its *results*.

---

## 5. The state schema (chat scope)

This is the Phase-1 `<dungeon_state>` ledger, promoted to a typed object tree. Draft Zod in §10. Shape:

```
dungeon: {
  meta: { turn, depth, schema_version, seed },
  light: { source, ticks_remaining } | null,
  player: {
    name, class, level,
    hp: { cur, max },          // script enforces [0,max]
    defense,
    stats: { str, dex, con, int, wis, cha },
    skills: { <skillName>: { rank, marks, marks_needed } },
    conditions: [ { name, ticks } ],
    location: "R03"            // current room id
  },
  inventory: [ { id, name, qty, equipped, worn, notes, charges } ],
  quest: [ { id, text, done } ],
  rooms: {                     // THE MAP GRAPH — append-on-discovery
    R01: {
      id, name, descr,
      exits: { north: {to:"R02", type:"open"}, east:{to:"R04",type:"door",state:"locked"}, ... },
      contents: [ {id,name,qty} ],   // dropped items, corpses, features
      visited: true
    },
    ...
  },
  bestiary: { <mobType>: { sprite_fragment, hp_base, defense } },  // canonical visual + stats per type
  combat: {                    // present only during fights
    active: bool,
    mobs: [ { id, type, name, hp_cur, hp_max, status, pos } ]
  },
  delta_log: [ "HP 5->2 (drowned strike)", "took rusty_key", ... ]  // per-turn, cleared each turn
}
```

**Invariants the applier enforces (the whole point):**
1. **Topology lock.** Mutations to `rooms.*.exits.*` are restricted: may add an exit only to a not-yet-present direction, may change `state` (locked→open, etc.), may **never** delete an exit or redirect `to` (except a `secret` reveal flag flip, or explicit in-fiction destruction signalled by a dedicated command). Reciprocity auto-maintained: setting `R02.exits.north={to:R03}` auto-writes `R03.exits.south={to:R02}` if absent.
2. **Inventory legality.** `remove`/decrement only if present in sufficient qty; `equip` only if owned. Reject (and log) otherwise.
3. **Numeric bounds.** `hp.cur` clamped `[0, hp.max]`; marks roll into rank-ups by the script, not the model (compute, don't trust).
4. **Old-value confirmation.** If a `set` declares an old value that doesn't match stored, log a desync warning to console + delta_log; apply the new value but flag it (the model hallucinated a prior state — visible, not silent).
5. **Append-only rooms / bestiary.** Existing room ids and bestiary fragments are immutable except for whitelisted mutable subfields (`contents`, `exits.*.state`, `visited`).

---

## 6. Prompt injection (state → model each turn)

On prompt assembly (Tavern Helper macro / ST-Prompt-Template, or a generation-start hook), inject a **compact** authoritative block at low depth — NOT the whole tree. The model needs *situational* truth, not the database:

```
[CURRENT STATE — authoritative, obey over your own memory]
Turn {turn} | Depth {depth} | Light: {light}
You are in {room.name} ({room.id}). Exits: {render exits with state}.
Here: {room.contents} | Mobs: {combat.mobs present}
HP {hp.cur}/{hp.max} | {conditions}
Carrying: {inventory one-liners}
{if combat: per-mob hp/status}
```

Everything else (full map graph, bestiary, untouched rooms) stays in storage and is referenced only when needed (e.g. on movement, the applier reads the target room from storage and the *next* injection reflects it). This is the token win: the model stops re-reading and re-emitting the map every turn.

**Preset change:** replace Phase 1's "emit the entire `<dungeon_state>`" instruction with "emit only changed values inside `<UpdateDungeon>` using `_.set/add/remove(...)`." The Crawl Pipeline CoT's Task 7 shrinks from "transcribe full ledger" to "list mutations." This should *further* cut the thinking-token cost we already attacked in v0.1.2.

---

## 7. Rewind, swipes, and branching (the message-scope trick)

Problem: chat-scope state is global to the chat, so swiping a message or editing back leaves state ahead of the narrative.

Solution (from Tavern Helper's design): after applying mutations to `chat` scope, **also snapshot the post-turn state into the `message` scope** of the AI message just produced (`{type:'message', message_id:'latest'}`), which is swipe-indexed. On swipe/edit/regenerate, a hook reads the snapshot from the message being returned to and **restores it into chat scope**. This makes state follow the timeline. MVU has a `cleanup/restore_variables` module doing essentially this; we implement a lean version. Mark this **Phase 2.1** — get linear play correct first, then add rewind integrity.

---

## 8. Build phases (suggested milestones for Claude Code)

- **M1 — Schema + init.** Define Zod schema (§10). `registerVariableSchema`. Port chargen: write the completed sheet into chat-scope vars from the STScript/QR opening instead of prose. Inject state block (§6). No mutations yet; model still narrates, state is seeded and displayed.
- **M2 — Parser.** Reimplement `extractCommands` with the paren-counting state machine (§3.2). Unit-test against nasty inputs (nested parens, strings containing `);`, multiple commands, `//reason` with URLs). Pure function, no ST needed — test in isolation.
- **M3 — Applier + invariants.** `updateVariablesWith` integration; implement §5 invariants (topology lock first — it's the headline feature). Wire to `GENERATION_ENDED`. Now state is authoritative and mutation-driven. **This is the milestone that kills drift.**
- **M4 — Preset surgery.** Fork DungeonSIM → DungeonSIM-MVU: swap full-ledger emission for `<UpdateDungeon>` mutations; rewrite CoT Task 7; thin the injection. Playtest 30+ turns with backtracking — compare drift vs Phase 1.
- **M5 — Rewind safety (§7).** Message-scope snapshots + restore-on-swipe.
- **M6 — SVG map render.** This is your original MUDMap work, now fed by `rooms` graph instead of parsed prose. Fixed-topology graph → SVG; current room highlighted. The map was always the custom piece; the schema makes it trivial to source.
- **M7 — Sprite seed-locking.** Per-entity deterministic seed = hash(entity id); store on bestiary/inventory entries; pass with image request so a given mob/item renders identically every time. (Phase-1 sprite protocol already stores canonical fragments — this adds the seed.)

---

## 9. Optional later: deterministic combat math (the MVU "no AI damage" idea)

MVU advertises "no random damage generation by AI — formula-based." We deliberately keep adjudication in the model for open-endedness, BUT the **arithmetic** can move to the script without losing that: model emits `_.add('player.hp.cur', -3);//drowned strike` and the script clamps/logs; or richer, the model emits the *event* (`mob drowned_02 hits player, medium weapon, solid`) and a script combat resolver computes damage from weapon class + degree tables (the Phase-1 combat block, ported to JS). Keep this **out of v2.0** — prove state persistence first. Flagged because it's the last drift source (the model doing math) and the path to removing it is clean.

---

## 10. Starter artifacts (in this handoff)

- `dungeon-schema.zod.ts` — first-draft Zod schema for the chat-scope state tree (§5), ready to refine in Claude Code. Importable shape + `registerVariableSchema` call sketch.
- `extract-commands.spec.md` — the parser contract + test cases to implement in M2 (behavioural spec so you can TDD it).
- Phase-1 files for reference: `DungeonSIM.json` (v0.1.2 preset), `DungeonSIM-Regex.json`, `The-Dungeon-card.json`.

---

## 11. Reference map (where to look in the cloned repos)

In your Claude Code folder you'll have `JS-Slash-Runner` (Tavern Helper). Key files:
- `src/function/variables.ts` — **the API we build on.** Read `updateVariablesWith`, `registerVariableSchema`, the `VariableOption` union, the `message`-scope read/write (note the swipe-id indexing).
- `src/function/index.ts` — confirms what's exported to scripts.

If you also pull MVU **for design reference only** (do not install/run):
- `src/function/update_variables.ts` — `extractCommands` (~L282), `findMatchingCloseParen`, `parseCommandValue`, command translation. **Reimplement, don't import.**
- `src/variable_def.ts` — `StatData`, `SchemaNode`, `ValueWithDescription`, `$meta`/`template` patterns.
- `doc/tutorial.md` — the `<UpdateVariable>` / `_.set('path',old,new);//reason` syntax and the `stat_data` vs `display_data` explanation.
- **AVOID:** `src/prompts/*.txt` (obfuscated jailbreaks), `src/function/update/invoke_extra_model.ts` (the path that injects them).

---

## 12. The one-paragraph brief (paste into Claude Code to start)

> Building Phase 2 of an LLM dungeon-crawl ("DungeonState") as a SillyTavern Tavern Helper script. State lives in Tavern Helper chat-scope variables (typed via a Zod schema), not in model prose. Each turn the model emits mutation commands `_.set('path',old,new);//reason` inside `<UpdateDungeon>` tags; my script parses them with a paren-counting state machine, validates against the schema, enforces invariants (topology lock on the room graph, inventory legality, HP bounds, old-value desync detection), and applies them via `updateVariablesWith`. On prompt assembly I inject only the compact current-situation block, not the whole map. Design and parser ideas are adapted from MVU/MagVarUpdate, but I am NOT depending on that package (it ships obfuscated jailbreak prompts) — I'm reimplementing on Tavern Helper directly. Start with M1: the Zod schema and seeding chargen state. See DungeonState-Design.md §5 and §10.

---

## 13. TTRPG depth layer (post-M3 content, parked)

*Captured during Phase-1 play. NOT new engine work — texture and permission on top of the existing adjudication primitive. Build as the FIRST content authored against the schema, after M3, because every element below wants to be a persisted field rather than re-emitted prose.*

**Core principle:** the LLM was put under this game precisely to adjudicate thematically-appropriate actions the rules don't enumerate. This layer is permission + texture so the model reaches for `action_resolution_engine` more readily in the magical and tactical register. Enumerate ONLY what touches tracked mechanics; adjudicate everything else freely.

- **Caster cantrips (enumerate — they touch tracked state).** Short fixed list per caster class for effects that interact with persisted mechanics, so behaviour doesn't drift. Priority case: **Light** (1 charge, illuminates current room, ~10 ticks) — plugs into the existing light/darkness tracking that the time-skip danger modifier and dark-room sensory limits already key off. Others: mend, spark, a minor ward, detect. Each becomes a `conditions`/`light` entry with a real duration, not prose.

- **Ritual / improvised magic (do NOT enumerate — adjudicate).** One license block: cleric blessing a room, turning/driving undead, consecrating a threshold, a mage improvising an effect from components — all legitimate attempts, each gets an honest DC keyed to class + circumstance + resources, with real consequences (success, partial, backfire). This is the same primitive as Jeremy's improvised trip-line, in the magical register. The block is ~200 words, genre-agnostic.

- **The Elbereth principle (the design north star for this layer).** NOT a hardcoded ward. The value is "a player can take an interesting, thematically-resonant action and have it genuinely matter." Hardcoding specific gestures betrays the open-endedness; enabling the *class of move* is the whole point. Applies equally to non-protective actions (carving a warning, leaving an offering, invoking a name).

- **Multipart / complex combat maneuvers (mostly adjudicate; results become tracked).** Fighter executing "hook the shield down, then headbutt", disarms, shoves into hazards, called shots, two-stage actions. Adjudicated through the combat + resolution engines; the *outcomes* become real tracked statuses (mob `status: "off-balance"`, `"disarmed"`, `"prone"`; player `conditions`). The texture is in the adjudication; the persistence is what makes it stick across turns.

**Why post-M3 / why it justifies the engine.** Right now a blessed room, a ward's remaining duration, a cantrip's ticks, or a mob's "off-balance" debuff would live in fragile re-emitted prose. Once DungeonState is authoritative these are trivial and durable:
- room effects → `rooms.<id>.effects: [ {name, ticks} ]`  *(new schema field)*
- caster/temporary effects → expand existing `player.conditions`
- maneuver results → existing `combat.mobs[].status`
So this layer is the natural first thing to author against the schema — almost a justification for building it. Enumerate only what touches persisted mechanics; adjudicate the rest.

**Schema impact when built:** add `effects: z.array(z.object({name, ticks: z.number().nullable()})).default([])` to `RoomSchema`; no other structural change (conditions and mob status already exist).
