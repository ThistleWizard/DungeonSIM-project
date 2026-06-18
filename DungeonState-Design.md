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

## 13. Conditional injection — the content-cartridge architecture (post-M8)

*Captured during Phase-1 play and expanded into the project's content architecture. This is the unifying idea for ALL expandable depth: class abilities, spells, regional content, faction mechanics, lock/portal gameplay. Build the SYSTEM as foundation-adjacent; populate it minimally for v1; the full content library is v1.1+. NOT started until the shippable Gold Box core (M1-M8) is done.*

### The principle (the same move, a third time)
The whole project moves things OUT of the static prompt into the deterministic layer, which injects only what is situationally live:
- **State engine (M1-M6):** inject the CURRENT room, not the whole map.
- **Conditional rules (this section):** inject the CURRENT character's/region's rules, not all rules.
Same abstraction, applied to RULES and CONTENT instead of state values. The payoff is identical and large: **context cost scales with where you ARE, not with how much game EXISTS.** A 40-region, 200-level world costs the same per turn as a 5-level one, because only the live cartridge is in context.

### Three injection kinds (mental model)
1. **Always-on engine** — the preset blocks (combat, resolution, prose, neutral bias). Every turn.
2. **Per-turn state** — the `[CURRENT STATE]` block from `inject.ts`. Every turn, current situation only.
3. **Conditional cartridges (NEW)** — bundles of rules/content, dormant until a trigger in deterministic state activates them. The deterministic layer is the switch: trigger is DATA, payload is RULES/CONTENT.

### Cartridges are DATA, not prompt
A `rules/` (or `content/`) dictionary keyed by trigger:
- `class.cleric` — pantheon, domains, divine spell list, turn-undead mechanic.
- `class.mage` — arcane schools, spell list, cantrips.
- `location.dwarven_mines` — faction defs (dwarves vs goblin/orc incursion), regional mob types + stats, loot tables, side-with-a-faction branching, regional flavor.
- `location.wizards_tower` — its own bestiary, mechanics, loot.
- (later) `condition.cursed`, `room.has_locked_exit` (lock gameplay), etc.

Each entry = rules-text (the fiction + how-to-adjudicate) + optional structured data (e.g. a spell list as JSON the model references). At injection time the deterministic side reads state, selects matching cartridges, and concatenates their text alongside the state block. A mage never sees the religion cartridge; a tower-climber never carries the mines' bestiary.

### Two axes, both proven by example
- **Class-triggered rules** (`player.class === 'cleric'`): who the player IS. Stable for the whole run — easy, inject for the session.
- **Location-triggered content** (`player.location` within a region, or `meta.depth` in a range): where the player IS. A region is a self-contained **content cartridge** loaded on entry, unloaded on exit. New region = new dictionary entry: zero engine changes, zero added per-turn cost elsewhere. This is the authoring economy that makes a big shareable world feasible — a frame (engine M1-M8) plus a library of cartridges; the world is the sum of cartridges authored. Someone else could write `location.sunken_cathedral` and drop it in.

### Within-cartridge branching (cartridges aren't static lore)
A region cartridge holds CONDITIONAL content keyed to schema state. Dwarven mines: side with dwarves -> some mobs turn friendly, loot opens, orcs escalate; side with orcs -> inverse; neutral -> both hostile. The branching STATE lives in the validated schema (e.g. a `region_state` / faction-standing field); the cartridge's rules-text tells the model how to READ that state and how player choices mutate it. So a cartridge = rules + instructions for how choices reshape the region — the open-ended, choice-driven core, scoped to an authorable domain.

### Three real caveats (design around, don't discover)
1. **Transition vs state triggers.** Class is set at chargen and never changes (trivial: latch for the run). Location/condition cartridges flicker on/off as the player moves; a cartridge appearing/vanishing mid-conversation can confuse the model (abilities silently appearing/disappearing). Likely answer: some cartridges, once activated, LATCH for the session even if the trigger passes. v1 starts with the clean cases (class-triggered, region-on-entry); latched dynamic triggers are a later question.
2. **New authoring surface = feature-creep risk.** Cheap-to-add is how scope balloons. Build the SYSTEM; populate it minimally for v1 (enough per-class flavor to make classes distinct; ONE or TWO polished regions). A full twelve-deity pantheon, or ten regions, is exactly the §15 someday-pile. The architecture must hold the full library (costs nothing extra, and building it narrowly is the thing you'd regret); the CONTENT ships disciplined.
3. **Validation/consistency.** Any cartridge-granted ability with MECHANICAL effect (a spell, a faction standing) needs a home in the validated schema so injected rules and tracked state stay coherent. Same principle as before: enumerate only what touches tracked mechanics; describe the rest as free fiction. Cartridges and schema co-design where they overlap.

### This subsumes the old "TTRPG depth layer" and lock/portal gameplay
- **Cantrips / ritual magic / class abilities** become per-class cartridges (`class.cleric`, `class.mage`), not one monolithic block. Enumerated cantrips that touch tracked state (e.g. Light -> the light/ticks mechanic) live in schema; free ritual magic is adjudicated. (The Elbereth principle still governs: enable the CLASS of thematically-resonant action and make it matter; don't hardcode specific gestures.)
- **Multipart combat maneuvers** -> results become tracked statuses (mob `status: off-balance/disarmed/prone`), as before.
- **Lock gameplay** (overcoming pickable/magical/barred/sealed) becomes a cartridge triggered when the player faces a revealed lock.
- **Enter/portal/vertical gameplay** (Gnomish-Mines branch-to-deeper-floor vs UUII same-area teleport) is region-transition logic that cartridges and the applier handle.

### Schema impact when built
Add `region_state` (or similar) for within-cartridge branching/faction standing; expand `player` to hold class-granted known spells/abilities (so cartridge rules and tracked state cohere); room `effects` already added for §-style effects. The cartridge dictionary itself lives outside the per-chat state (it's authored content, like the preset) and is referenced by the injection layer.

### Sequence
Post-M8 (after the shippable Gold Box core). Build the injection/cartridge SYSTEM first; ship with class flavor + one polished region (the dwarven mines is the natural candidate — factions, branching, a self-contained 5-level arc). Everything else is v1.1 library growth.


---

## 14. Gold Box panel display (M8, speculative — later design goal)

*Captured as a long-term visual target. Clearly SUBSEQUENT to M4 patches, M5 rewind, and M6 map render. Not started until those are solid. Feasibility is high BECAUSE the state engine already holds everything as structured data — every panel is a pure render of a slice of the tree.*

**The target:** the classic SSI Gold Box four-zone screen (Pool of Radiance / Champions of Krynn lineage): all live at once instead of a single scrolling column.
- **Viewport panel** — current mob / scene 8-bit sprite. Reads the current encounter's `bestiary[type].sprite_fragment` (+ M7 seed for the actual image).
- **Text panel** — scrolling narration + combat log. This is ST's chat surface.
- **Sheet panel** — character sheet. Reads `dungeon.player` (hp, stats, skills, conditions, level).
- **Map panel** — automap. Reads `dungeon.rooms` (the graph). This IS the M6 SVG render, placed in a quadrant.

**Feasibility:** the data is already there — this is the payoff of decoupling state from prose. `formatStateBlock` (inject.ts) is already a state→text serializer; the panels are the same idea rendering to HTML/SVG boxes. Tavern Helper can manage DOM. Elaborate display mods for ST exist, so the platform supports it.

**Two build paths (decide at M8, not now):**
1. *In-ST overlay (recommended first version)* — inject a styled, CSS-quadrant container that reshapes/overlays the chat area; panels populated by the extension from chat-scope vars. Keeps everything in one tool. Cost: perpetually fighting ST's chat-centric CSS; ST updates can break the layout.
2. *External display (fallback / honest decoupling)* — a lightweight page served off the Pi reads the same state tree and renders the full layout properly; ST runs alongside as input/text. More moving parts, no CSS wrestling, survives ST updates. Viable precisely because state is no longer trapped in the chat client.

**Build principle — modular panels for portability.** Implement as components that each take a state slice and render: `renderSheet(player)`, `renderMap(rooms)`, `renderSprite(mob)`, etc. Then the SAME components work in either host — if the in-ST overlay fights too hard, lift them into an external page without a rewrite. Build path 1 first to prove the panels render correctly from the store (the real value); keep the option on path 2.

**TOGGLEABLE — hard requirement.** Must be a switch, defaulting OFF / to plain chat. Rationale: Paul plays on mobile often, where a four-quadrant layout is unreadable. The panel display is a desktop immersion feature; mobile and small screens fall back to the normal single-column chat (the game must remain fully playable as plain text — the panels are a VIEW, never a requirement). A simple settings toggle (and/or auto-disable below a viewport-width breakpoint) gates the whole overlay.

**Dependency on M5 (important):** a live panel UI reading chat-scope state will display INCORRECTLY on swipe/rewind unless M5's message-scope snapshot consistency is solid — map/sheet would show post-turn state while the text shows the rewound turn. The pretty display therefore RAISES the stakes on getting rewind right. Do not build M8 until M5 is correct and tested.

**Sequence:** M4 patches → M5 rewind → M6 map render (feeds the map panel) → M7 sprite seeds (feeds the viewport panel) → M8 panel display assembles the four zones. M8 is largely a CSS/layout + component-wiring project once M6/M7 exist; almost no new state work.

---

## 16. Narrative-thread tracking (post-M8) — and the anti-railroading mandate

*The fifth pillar. Every other system keeps the WORLD consistent (geometry, state, rules, content); this keeps the STORY consistent — it closes the gap between "a dungeon that remembers its geometry" and "a dungeon that remembers its promises." Build the SYSTEM post-M8; seed lightly for v1; full use is v1.1. Read the anti-railroading section first — it is the spine, not a caveat.*

### The design north star (the thesis everything serves)
DungeonSIM is a **single-player freeform tabletop experience in Gold Box clothing**: the structure and legibility of a CRPG with the actual creative latitude of a good DM behind the screen. The point of an LLM narrator is that the player can do whatever they think of; the model simulates, responds, and challenges, but MUST NOT railroad. Every architectural choice is downstream of this. The thread system tests it hardest.

### The failure mode it solves
Models write something evocative — Jeremy gets a cursed ring — then the thread exists only as PROSE in the context window. It scrolls out, and the Chekhov's gun never fires: nothing remembers it was loaded. Same "interesting thing lives only in fading prose" failure this project solves everywhere else, now for NARRATIVE threads.

### Why preset "Chekhov trackers" are mediocre (and ours can work)
FrankenSIM-class presets ask the MODEL to track hooks in a prose block it re-emits each turn — the re-emission fragility already killed for state: drifts, hooks silently vanish, no enforcement. We have the deterministic layer they don't: hold threads authoritatively, surface them when relevant, never lose them.

### THE ANTI-RAILROADING MANDATE (the spine — design against the host's instincts)
RLHF-tuned models are EAGER. Eagerness + a tracked objective = a sycophantic DM: told the cursed ring matters, it mentions the ring every turn, telegraphs its importance, nudges the player toward it, and treats not-resolving-it as failing the task. That is the assistant reflex ("open objective -> make progress -> the user will be pleased"). A good DM does the opposite: holds the ring in their back pocket, says nothing, waits — maybe forever, if the player melts it down for components. A thread is **latent leverage, not pending homework.** The craft is restraint.

This battle is won or lost in the INJECTION FRAMING. The same stored thread, surfaced two ways, produces opposite behavior:
- BAD: `ACTIVE QUEST: resolve the curse of the ring` -> the model nags.
- GOOD: `The ring's curse remains dormant and unmentioned; it MAY surface if dramatically apt, or never.` -> the model is given PERMISSION TO STAY SILENT, which assistant-tuning will not supply on its own.
The tracker's job is NOT to remind the model to act. It is to PRESERVE THE OPTION to act (so a good beat isn't lost to context) while explicitly LICENSING INACTION. This inverts how presets frame Chekhov trackers, and the inversion is the whole insight.

**Deeper principle (generalizes past threads):** tune the model, via architecture, toward being a WORLD, not a STORYTELLER. A world has latent possibilities the player's choices activate; a storyteller has a tale they're pushing. The neutral-bias block already does this for MECHANICAL fairness (indifferent dungeon, doesn't scale, answers recklessness in full). Threads need the NARRATIVE equivalent: the dungeon CONTAINS unresolved threads the way it contains unopened doors — there if you pull on them, inert if you don't, no urgency to make you. "Indifferent" is the key word in both registers: the cursed ring no more wants to complete its arc than a locked door wants to be opened. Give the model the identity (indifferent world) that makes restraint IN-CHARACTER rather than a suppressed instinct.

### Two halves: reactive core (recommended) vs proactive seeding (risky layer)
- **Reactive capture (CORE, unambiguously good).** When the model writes something with narrative promise, a thread is recorded in the deterministic layer (persists past context). The injection layer surfaces ACTIVE, IN-SCOPE, UNRESOLVED threads back into context at relevant moments — framed per the mandate above — so the model CAN fire the gun when apt. Closes when resolved (or marked failed/abandoned).
- **Proactive seeding (OPTIONAL, restraint-required).** Generate a few latent hooks per level/region up front, woven into rooms, so exploration CAN reveal an arc. Double-edged: pre-authored arcs become rails if the model commits hard to a plot. Resolution: seeded hooks are LATENT and OPTIONAL — "this level CAN yield these threads if pulled on," never "this level WILL tell this story." Seed sparingly. Region cartridges (§13) may carry a few region-appropriate hook-seeds that activate on entry. Lead with reactive; treat seeding as a tunable layer, framed as affordances not plot.

### Architecture (the same pattern a fifth time)
A `threads` structure in the schema. Each thread: `id`, `description`, `status` (`latent | active | resolved | failed`), optional `anchor` (entity/room id it attaches to), optional `scope` (level/region — so it deactivates when you leave, like cartridges). The model emits thread mutations through the EXISTING `_.set`/`_.add` command channel — open on introduction, advance, resolve. The applier persists them. The injection layer surfaces only LIVE (active, in-scope, unresolved) threads — same selectivity as the room/state injection. Composes with §13 cartridges: a region ships latent hook-seeds that activate on entry and surface as explored.

### Three caveats (consistent with the ones already managed)
1. **Surface-it-relevantly (the hard part, expect playtest iteration).** Dumping all open threads every prompt = noise + bloat; never surfacing = stored but inert. Judgment on WHEN to remind: when the anchoring entity/room is in play; periodically for level-scoped threads; a gentle nudge if dormant too long. Tuning problem, the thing most likely to need iteration.
2. **Don't force resolution.** A tracked thread must not make the model feel obligated to resolve it NOW (every thread firing predictably kills suspense). The system records and OPTIONALLY reminds; the model decides timing. Framing: "this remains open," never "resolve this."
3. **Discipline.** Build the system; seed lightly for v1. A couple of reactive threads that actually pay off > an elaborate hook engine that railroads. v1.1 territory; pairs with §13 (threads are another conditional, scoped, injected-when-live structure); sits after the shippable Gold Box core.

### Schema impact when built
Add `threads` (array or record) per the shape above. The injection layer gains a thread-selection + framing step (the mandate). No change to the mutation channel or applier core (threads use existing verbs); the applier may gain a light guard (e.g. resolved threads are terminal). 

---

## 15. Status log & milestone state (living)

*Updated as milestones land. Keeps the "someday pile" visible and dated so deferred ideas don't nag during the push to a shippable Gold Box core.*

**Done & validated (live-tested in SillyTavern):** M1 schema, M2 parser, M3 applier + invariants, M4 patches (all four landed), M5 rewind/swipe safety (reviewed; one-line deletion-scan fix applied; 71 tests + 8 adversarial pass).

**M6 automap — done & live-verified in SillyTavern:** see `DungeonState-M6-spec.md`. Pure `renderMap()` in `src/map.ts` (deterministic + stable grid-walk, current-depth filter, current-room amber highlight, undiscovered `?` stubs, vertical/portal markers, `data-room-id`/`<title>` hooks) + exported `computeLayout` seam; `/map` slash command in `src/commands.ts` (injectable `registerMapCommand` + `bootstrapCommands` reading `SillyTavern.getContext()`), wired from runtime's bootstrap. Forward-compat schema fields landed (additive/defaulted, M1–M5 safe): exit `category`, true `lock`, `lock_revealed`; room `depth` — portals/branches/discoverable-locks are REPRESENTABLE; their gameplay stays deferred. The knowledge model is **cartographer-style** (a deliberate refinement of B6, confirmed with the user): the map shows what the player can SEE (the exit's fiction/`type`) but hides the WIRING (`category`) and destination until a link is traversed — so visible stairs read as `↓`/`↑` immediately (you can see the staircase in your own room), while a trapdoor disguised as an archway stays an ordinary unexplored stub until used. Secret (`state:'hidden'`) exits and unrevealed locks render nothing. All test-guarded; 86 tests pass. **Live-confirmed:** `/map` registers and renders an accurate current-depth automap in the running app.

**M8 prep — sheet + inventory renderers built (pure, unit-tested; live-test pending):** `src/sheet.ts` (`renderSheet`, `renderInventory`) renders the full structured Gold Box character sheet (identity, HP bar, defense, light, six abilities, skills with rank-dots + marks-to-next, condition chips) and inventory (qty, equipped/worn/charges, notes) as styled HTML straight from `player.*` / `inventory[]` — the same anti-drift move as the automap (engine prints it, can't disagree with state). Wired as `/character` + `/inventory` via `registerAllCommands`/`bootstrapCommands`. Pulled forward so M8 collapses to layout/CSS over proven renderers. (`/spellbook` deferred: no spells/known-abilities field exists in the schema yet — that arrives with the §13 class-cartridge layer, and the renderer is trivial once it does.)

**Next: M7 sprite system — CACHE-first, not generate-every-turn (decided with the user).** The reframe: generating an image each turn is slow, costly, and ironically inconsistent for a deterministic thing. So the cache is the consistency + speed guarantee; `hash(id)` → seed is only the *regeneration recipe* (a seed alone reproduces an image only on the same backend/sampler, so it can't be the guarantee). Lifecycle: a new entity (bestiary type / inventory id) gets its canonical fragment + seed, the runtime checks a sprite cache → on miss it fires generation **async, off the turn's critical path**, stores the result keyed by id; every later encounter is a cache hit (instant, free, identical). **Backend = hook ST's Image Generation extension** via its `/sd` slash command (`triggerSlash('/sd quiet=true <fragment>')`) — that inherits whatever Source the user has configured, so "default to match SillyTavern" needs zero backend code; an explicit override is a later thin setting. Toggleable (off → text/placeholder; finicky generation never blocks play). Bytes live in a side store (ST asset / IndexedDB / TH file API); state holds only a ref. Sprites attach to TYPES (one `drowned` image for all instances), items by id. **Location sprites deferred** (generic per-archetype backgrounds are out of scope for v1). M8 viewport focus is state-driven: `combat.active` → mob, examine → item, else → location. → M8 Gold Box panel layout (§14). After M8 the shippable core is complete.

**The shippable v1 target (the line that defines "done"):** character lifecycle (chargen→descent→permadeath, working) + authoritative state (M1–M5, done) + Gold Box four-panel view (M6→M7→M8) + content polish so a stranger gets it unaided. Everything below is v1.1+ richness, deliberately deferred:

- **§13 conditional-injection / content-cartridge architecture** — the unifying system for expandable depth: per-class rules cartridges (cantrips, spells, abilities), location cartridges (regional bestiary/loot/factions, e.g. dwarven_mines), within-cartridge branching via schema state, lock/portal gameplay as triggered cartridges. Build the SYSTEM post-M8; ship with class flavor + ONE polished region; full library is v1.1+. Additive token cost: context scales with where you are, not how much game exists.
- **Lock gameplay** — overcoming `pickable`/`magical`/`barred`/`sealed` (lockpick/knock/bash/remote-mechanism). Pairs with §13. M6 renders locks once revealed; doesn't resolve them.
- **Enter/portal/vertical gameplay** — `enter` that spawns a deeper level (NetHack Gnomish-Mines trap) vs same-area teleport (Ultima Underworld II portal). Surface fiction (`type`) is independent of interior wiring (`category`); the divergence is a design tool (a ritual circle that's secretly a trapdoor to depth 3). M6 renders these as markers; doesn't spawn the destinations.
- **Graduated lock discovery** — binary (one interaction reveals full lock nature) for now.
- **§16 narrative-thread tracking** — reactive capture of narrative hooks (the cursed ring problem) held in the deterministic layer and surfaced when relevant, framed to LICENSE INACTION (anti-railroading mandate); optional sparing proactive seeding. Build post-M8; seed lightly for v1. The pillar that keeps the STORY coherent as the others keep the WORLD coherent.
- **Multi-level map view, sprite reference-sheet img2img (§ earlier note), manual save/export, schema migration** — all parked.

**Guiding discipline:** inspired by NetHack/Dwarf Fortress depth, but those are decades-long no-ship-date projects. The path to sharing DungeonSIM is a COMPLETE Gold Box experience, not a maximal one. Keep ideas in the pile until the core ships.
