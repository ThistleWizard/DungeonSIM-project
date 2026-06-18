# DungeonState — M6 spec: the automap (`renderMap` + `/map`)

**Goal:** a pure `renderMap()` that turns the canonical `dungeon.rooms` graph into a clean 8-bit SVG automap, shown via a `/map` slash command. Grid-walk layout, current depth only, current-room highlight, undiscovered-exit stubs, hover/click detail. Plus minimal forward-compat schema fields so portals and lock-types are *representable* now and the renderer never needs rework when their gameplay lands later.

**Design lineage:** confirmed against rendered prototypes — grid-walk beat force-layout decisively for a compass-based dungeon (readable as a *place*, north-is-up, loops close). Inspirations: Gold Box automap (look), NetHack Gnomish Mines (branch-to-deeper-level), Ultima Underworld II portal spell (same-fiction-different-wiring teleports).

**Ship discipline:** M6 makes richer worlds *representable*; it does NOT implement their gameplay. Everything in "Deferred" stays deferred. Resist scope creep — the goal is a complete Gold Box experience to share, not a maximal one.

---

## Part A — Schema enrichments (small, forward-compat, must not break M1–M5)

All additive with defaults, so existing saved state and all current tests stay valid. Edit `src/schema.ts`.

### A1. Exit: link category (spatial vs vertical vs portal)
Distinguishes edges the grid-walk can place (compass) from links it must NOT try to place spatially (stairs, portals). Add to `ExitSchema`:
```ts
  // How this link relates to space, for layout. Defaults to 'spatial' so every
  // existing exit grid-walks exactly as before.
  category: z.enum(['spatial', 'vertical', 'portal']).default('spatial'),
```
- `spatial` — the eight compass directions; grid-walked into cells.
- `vertical` — up/down between depths (stairs, ladder, hole, ritual-trapdoor); rendered as a depth-marker, never a positioned edge.
- `portal` — non-spatial same-or-other-area teleport (ritual circle, arch); rendered as a named marker, never a positioned edge.
NOTE: `category` is the INTERIOR WIRING, independent of `type` (the fiction). A `type:'archway'` exit can be `category:'portal'`. A ritual circle that's secretly a trapdoor to a deeper floor is `category:'vertical'` with whatever fiction `type`. The divergence between fiction and wiring is an intended design tool (a portal that's really a trap to depth 3). The model sets both.

### A2. Exit: true lock + discovery flag (discoverable locks)
The map renders from PLAYER KNOWLEDGE, not ground truth. The model knows the real lock; the player learns it by trying the door. Add to `ExitSchema`:
```ts
  // The TRUE access requirement (model-authoritative; used to adjudicate attempts).
  // 'none' = freely openable. The others are obstacle SEEDS; the emergent puzzle of
  // overcoming them is resolved by the action-resolution engine, not coded here (deferred).
  lock: z.enum(['none', 'key', 'pickable', 'magical', 'barred', 'sealed']).default('none'),
  // Has the player DISCOVERED this exit's lock nature? Binary for now (one interaction
  // reveals the full lock type). The renderer shows lock styling only when true.
  lock_revealed: z.boolean().default(false),
```
Keep the existing `state` enum as-is — `state` is the door's *current physical* condition (open/closed/locked/barred/broken/hidden), which the player can see; `lock` is the *mechanism* behind overcoming it, which they discover. (Yes, `state` already has 'locked'/'barred' values; that's fine — `state:'locked'` can mean "visibly locked" while `lock` says *how* it yields. If this dual vocabulary feels redundant during implementation, the minimal reconciliation is: `state` = physical/visible, `lock` = how-to-open/discovered. Don't over-engineer it.)

### A3. Discovery flag for the exit's existence (stub vs known)
The renderer already infers "stub" as `exit.to` not being a known room. That's sufficient for M6 — no new field needed. (An exit whose target room exists in `dungeon.rooms` is traversed/known; one whose target doesn't is an undiscovered stub.) Leave as-is unless playtest shows a need for "seen but target-room-not-yet-created" nuance.

### A4. Tests for schema (add to `tests/schema.test.ts`)
- `emptyDungeon()` still parses; a room with a bare exit `{to,type}` still validates and gets `category:'spatial'`, `lock:'none'`, `lock_revealed:false`.
- An exit with `category:'portal'` validates.
- Existing M1–M5 suite still green (regression).

---

## Part B — The renderer (`src/map.ts`, new file)

Pure function. No SillyTavern. Fully unit-testable, M1–M5 style.

```ts
export function renderMap(
  rooms: Record<string, Room>,
  currentRoomId: string | undefined,
  depth: number,
  opts?: MapRenderOptions,   // tunable style constants; all optional
): string   // returns an SVG string
```

### B1. Depth filtering (current level only)
Render only rooms on `depth`. **Problem:** `RoomSchema` has no `depth` field today. Two options — pick the simpler:
- **Preferred:** add `depth: z.number().int().min(1).default(1)` to `RoomSchema` (additive, defaulted — safe). The model already tracks `meta.depth`; stamp each room's depth at creation. Then filter `rooms` to those matching the arg.
- Fallback (no schema change): derive reachable-same-level set by walking only `category:'spatial'` edges from `currentRoomId`, treating `vertical`/`portal` as level boundaries. More code, less robust. Recommend the schema field.
Vertical/portal exits from on-level rooms still render as MARKERS (B5), they just don't pull their target room onto this level's canvas.

### B2. Grid-walk layout (deterministic + STABLE)
- Direction vectors (8 compass): `north[0,-1] south[0,1] east[1,0] west[-1,0] northeast[1,-1] northwest[-1,-1] southeast[1,1] southwest[-1,1]`.
- BFS from a STABLE root: prefer `R01` if present on this level, else the lowest-id room on the level (NOT `currentRoomId` — the map must not re-anchor as the player moves). Deterministic root + deterministic BFS order (sort exits by a fixed direction order, sort sibling rooms by id) = **identical coordinates every render**.
- Place each room by stepping its spatial-exit vector from the parent's cell.
- **Collision nudge:** if a target cell is occupied, step the new room outward (e.g. +x, then spiral) to the nearest free cell. Log nothing to the player; the edge just bends slightly. Only `category:'spatial'` edges participate in walking.
- **Stability guarantee (REQUIRED, test it):** rendering the same `rooms` twice yields byte-identical coordinates; adding a new room never moves an existing room's coordinates. Achieve by always walking in the same deterministic order and only ever assigning a cell to a not-yet-placed room.

### B3. SVG output, 8-bit style (tunable constants)
Reuse the prototype's look (it was approved): dark bg `#0b0d10`, dotted grid texture, room boxes `#161b22` stroke `#4a5a6a`, monospace. Expose as `MapRenderOptions` with defaults: `cell`, `box`, `pad`, color palette, font sizes. Keep all magic numbers in one constants block so the look is dialable during playtest.

### B4. Per-room rendering
- Box with id (always) + name (wrapped to 2 lines if it fits the box; else id-only).
- **Current-room highlight:** `currentRoomId` gets the amber border `#e8c468`, inner outline, and an `@ YOU` tag.
- **Every node emits `<title>` (native hover tooltip) and `data-room-id="R##"`** — full detail on hover now; click-wiring for M8 panels later, free. `<title>` content: name + (if discovered) contents/mob summary. Keep `<title>` text derived only from PLAYER-KNOWN data (see B6).

### B5. Edges and non-spatial markers
- **Spatial edges** between two on-level known rooms: solid line `#3f6e8c`. If the connecting exit is `lock_revealed && lock !== 'none'`: dashed amber `#a06a2c` (the player has learned it's obstructed). If not revealed: plain solid (looks like an ordinary connection until they try it).
- **Vertical markers** (`category:'vertical'`): a small icon/badge on the room edge — `↓`/`↑` with a short label on `<title>` ("stairs down" / known destination depth if discovered). Never a positioned edge.
- **Portal markers** (`category:'portal'`): a distinct glyph (e.g. `⊙`) on the room, `<title>` showing the fiction name if known. Never a positioned edge. (Later, M8: clicking could jump the view to the linked area.)
- **Undiscovered stubs** (exit whose `to` is not a known room): short dashed line in the exit's true compass direction ending in a `?` box. `<title>` shows the fiction name if the model gave the unexplored exit one ("ritual circle"), else just the direction. CRITICAL: a stub reveals NOTHING about category or lock (see B6).

### B6. The three-layer knowledge model (CRITICAL — do not leak)
The renderer draws ONLY what the player has discovered:
1. **Undiscovered exit** → plain `?` stub. Does NOT show category (spatial/vertical/portal) or that it's a portal/branch. A ritual-circle-trap looks like any other unexplored way out. Its fiction name may show on hover only if the model surfaced it.
2. **Discovered-but-unopened door** (`to` unknown but the player has examined it) → still a stub; lock styling appears ONLY if `lock_revealed`.
3. **Lock nature** → rendered (dashed amber etc.) ONLY when `lock_revealed === true`. Before that, a locked door is indistinguishable from an open one on the map.
4. **Category** → drives rendering (edge vs vertical-marker vs portal-marker) ONLY for TRAVERSED links (target room known / link used). An untraversed `enter` exit renders as a generic stub regardless of its true category.
Write explicit tests that undiscovered locks and untraversed portal/vertical types do NOT appear in the SVG output (grep the SVG string for the leak).

### B7. Level counter
Corner badge: `DEPTH {depth}`. (Prototype already has this.)

---

## Part C — Display layer (`/map` command, thin, separate from renderer)

Keep wiring out of the pure renderer. In `runtime.ts` (or a small `commands.ts`):
- Register a `/map` slash command (Tavern Helper's slash-command registration, or an STScript Quick Reply that calls into the script).
- Handler: read current dungeon from chat scope (`readDungeon(store)`), call `renderMap(d.rooms, d.player.location, d.meta.depth)`, and display the SVG.
- **Display mechanism:** simplest first — inject the SVG as an HTML message into chat (Tavern Helper can render HTML), or a popup. Do NOT build a panel yet (that's M8). The `/map` command proving the renderer is the M6 deliverable; pretty placement is M8.
- Mobile note: the SVG should be width-responsive (viewBox set, no fixed pixel width forcing overflow) so it's legible on phone — consistent with the toggleable-display philosophy (§14).

---

## Part D — Test plan (`tests/map.test.ts`, M1–M5 rigor)

Pure-function tests, no ST:
1. **No collision on grid-coherent input** — the realistic 7-room loop dungeon places all rooms in distinct cells (0 collisions).
2. **Deterministic** — `renderMap(rooms,...)` called twice returns identical strings.
3. **Stable under growth** — extract room coordinates; add a new room linked off an existing one; re-extract; all previously-placed rooms have unchanged coordinates.
4. **Stub direction correctness** — an undiscovered exit `west` produces a stub left of its room; `northeast` up-and-right.
5. **Current-room highlight** — the SVG contains the amber highlight markup for `currentRoomId` and not for others.
6. **Depth filtering** — rooms on depth 2 do not appear when rendering depth 1; a `vertical` exit to depth 2 still produces a marker.
7. **Knowledge leak guards (the important ones):**
   - an exit with `lock:'barred', lock_revealed:false` produces NO dashed/amber lock styling.
   - an untraversed exit with `category:'portal'` (target room absent) renders as a generic `?` stub, with no portal glyph and no category hint in the output.
   - the same exit once `lock_revealed:true` DOES show lock styling (positive control).
8. **Collision nudge** — a deliberately non-Euclidean 4-room loop (N,E,S,W not closing) places all 4 in distinct cells (nudge fired, no overlap), and still renders without error.

---

## Deferred (logged, NOT in M6) — keep the someday-pile visible
- **Lock gameplay** — how `pickable`/`magical`/`barred`/`sealed` are actually overcome (lockpick checks, knock spell, STR bash, remote mechanism). Pairs with §13 TTRPG depth layer. M6 only renders the lock once revealed.
- **Enter/portal/vertical gameplay** — the logic that makes an `enter` spawn a new deeper level (Gnomish-Mines trap) vs a same-area teleport (UUII portal). M6 only renders these as markers.
- **Graduated lock discovery** — separating "it's locked" from "it's pickable vs needs-key". Binary for now.
- **Panel placement (M8)** — `/map` is a command in M6; the quadrant Gold Box layout is M8. The `data-room-id` + `<title>` hooks are seeded now so click-to-panel is free later.
- **Multi-level / stacked map view** — current-depth-only for now.

## Sequence reminder
M6 (this) → M7 sprite seed-locking → M8 Gold Box panels (consumes `renderMap` output + sprite + sheet). After M8, the shippable Gold Box core is complete; §13 and lock/portal gameplay are v1.1 richness.
