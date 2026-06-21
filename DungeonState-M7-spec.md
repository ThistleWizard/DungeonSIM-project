# DungeonState — M7 spec: sprite system (architecture kickoff)

**Status: NOT STARTED. This is a handover/kickoff for a fresh architecture session — the plan
recap + the seams already in place + the open questions to resolve. Flesh this into a full spec
during architecture, then build.** The authoritative long-form plan is design doc **§15**; read
it first. This file is the entry point so the architect session doesn't start cold.

## Where the project is (2026-06-20)
`main` is a working, persistent, good-looking dungeon crawl: deterministic state engine (items/
light/combat/movement/map all live-verified), M8 Gold Box display panel, and the full Gold Box
restyle (panel + ST chrome theme). M7 is the next milestone toward a shippable v1. Parked:
`resolution-philosophy` (§17 content rules, stale vs main, on hold pending playtest evidence).

## The decision already made: LIBRARY-first (supersedes the old generate-and-cache plan)
Don't make an unreliable image model reinvent a sprite every turn. Give the model a CONSTRAINED
SELECTION over a curated, tagged sprite pack — same division of labour as everywhere (model
decides WHAT, the script computes/locks). **Ladder: curated tagged pack (primary) → image-gen
fallback → text/placeholder (final).** This demotes the flaky thing (gen) to an edge case.

- **Selection = tags; resolution = script.** When a new bestiary TYPE first appears, the model
  emits descriptive tags (a structured form of the `sprite_fragment` it already writes, e.g.
  `["undead","humanoid","armored"]`). A PURE resolver matches tags → a concrete sprite
  deterministically, `hash(id)` as tie-break (two goblins → `goblin_01`/`goblin_02`: consistency
  AND variety), then writes the resolved sprite ref onto the bestiary entry, LOCKED thereafter.
  The model never sees the catalog (no token cost); the resolver is pure → unit-testable.
- **Pack-agnostic.** The pack is CONTENT, not engine: a manifest `{ id: { tags, src } }` outside
  per-chat state (like the preset / §13 cartridges). base64-inline viable (8-bit sprites are
  tiny) → self-contained, no asset hosting. Ship a CC0/licensed retro pack as the default.
- **Gen fallback** (cache-once): a missing sprite is generated ONCE via ST's Image Generation
  (`triggerSlash('/sd quiet=true <fragment>')`), cached by id; toggleable, off → placeholder,
  never blocks play. `hash(id)` is the seed/regeneration recipe; the cache (not the seed) is the
  guarantee.

## Seams already in place (built this session / earlier — don't rebuild)
- **Viewport sprite slot**: `renderViewport` in `src/display.ts` renders a Gold Box scene window
  with a positioned `data-sprite-slot` div (empty, shows `[sprite: M7]`). M7 fills this — ideally
  WITHOUT re-rendering the whole panel (target the slot by its data attr).
- **Bestiary schema**: `BestiaryEntrySchema` (src/schema.ts) already has `sprite_fragment`
  (8–15 word canonical visual, written once) and `seed` (`= hash(id)`, currently null). Append-
  only; the resolver writes the resolved sprite ref here and locks it.
- **Pure-renderer + injected-bootstrap pattern**: map/sheet/display all split a PURE renderer
  (unit-tested) from a guarded ST bootstrap. The resolver should follow this — pure core,
  ST-touching gen-fallback injected/guarded.
- **`esc()` coercion + crash-proof renderers**: renderers tolerate malformed state (don't throw).

## Open questions to resolve during architecture (the actual M7 design work)
1. **Tag vocabulary**: a fixed controlled vocabulary the model picks from, or free tags the
   resolver fuzzy-matches? Controlled = reliable matching; free = flexible but needs scoring. How
   does the model learn the vocab without seeing the catalog (preset instruction on the bestiary-
   add mutation)?
2. **Resolver matching algorithm**: tag-set → sprite scoring (overlap count? weighted? required
   vs optional tags?). Tie-break by `hash(id)`. What happens on NO match → gen fallback or generic
   placeholder by category?
3. **Schema additions**: does the bestiary entry gain a `sprite` (resolved ref/id) field, or
   reuse `seed`? Keep additive + defaulted (M1–M8-safe migration), like the M6 fields.
4. **Pack format + loading**: manifest shape, base64-inline vs file refs, where it lives (bundled
   in the script? separate file the script imports?), how a different pack drops in.
5. **Slot fill mechanism**: how the resolved sprite gets from bestiary state → the viewport
   `data-sprite-slot` (and the player sprite?). On every refresh, or once-locked then cached in
   the DOM? Interaction with the `onRefresh` registry + rewind.
6. **Mutation channel**: the model emits tags via the existing `_.assign('bestiary.<type>', …)` —
   confirm the applier/preset wiring; the resolver runs in the apply path or the render path?
7. **Gen fallback wiring**: ST `/sd` availability detection, caching location (per-chat? global?),
   the toggle, and keeping it non-blocking.
8. **Scope cut for v1**: mob sprites only, or player + room/scene too? The viewport caption today
   shows the faced mob OR the room — M7 minimum is the faced-mob sprite.

## Build order (when M7 starts)
Pure resolver + tests first (no ST) → schema field → preset instruction for emitting tags →
wire resolved ref into the viewport slot → ship a default CC0 pack → gen fallback last (the
edge case). Prove the pure selection path end-to-end before touching image generation.
