# Spec — script-owned skill rank-up rollover

**Branch:** `skill-rankup` (off `main`). Standalone deterministic-engine fix, **not** part of M7.
**Status:** noted, not yet implemented. Build test-first (the applier is the pure core).

## The gap (a half-built §5 invariant 3)

Invariant 3 (`DungeonState-Design.md` §5, restated in CLAUDE.md) says:

> Numeric bounds: clamp `hp.cur` to `[0, hp.max]`; **the script rolls skill marks into
> rank-ups (compute, don't trust the model).**

Only the HP clamp shipped. **The skill rank-up rollover was never implemented.** The applier's
post-apply passes are `applyDeaths` then `applyLight` (`src/applier.ts:602-610`) — there is no
skill pass anywhere in `src/` (grep `mark|rank` confirms: only the schema and the sheet
renderer reference them).

### Live symptom (M7 testing session, 2026-06-23)

A player at `5/5` melee marks never ranked up; the sheet's rank dots never advanced. Two
reported symptoms, **one root cause**:

1. "Mark indicators not increasing" — the sheet dots are `'●'.repeat(s.rank)`
   (`src/sheet.ts:70`), i.e. they track **rank**, not marks. Rank never increases ⇒ dots
   never move. The `marks/marks_needed` *number* does climb; the dots can't.
2. "Model missed a rank increase" — the model was never supposed to do it. The **script**
   owns rank-ups, and that code is absent. Marks accumulate to `marks_needed` and sit there
   full forever.

## The schema (already in place, `src/schema.ts:16-19`)

```ts
export const SkillSchema = z.object({
  rank: z.number().int().min(0).max(5).default(0),
  marks: z.number().int().min(0).default(0),
  marks_needed: z.number().int().min(1).default(3), // script recomputes = 3 + 2*rank
});
```

`player.skills` is `z.record(z.string(), SkillSchema)`. No schema change needed — the fields
exist; nothing computes them.

## The fix

A new pure post-apply pass, `applySkillRanks(d)`, registered alongside `applyDeaths` /
`applyLight` in `applyCommands` (order relative to those two doesn't matter; it only touches
`player.skills`). For every skill:

```
while marks >= marks_needed and rank < 5:
    rank += 1
    marks -= marks_needed          # ROLL OVER the excess (agreed), don't reset to 0
    marks_needed = 3 + 2 * rank     # recompute next threshold
if rank == 5:                       # capped
    marks_needed = 3 + 2 * 5 = 13
    marks = min(marks, marks_needed) # clamp so a maxed skill reads e.g. 13/13, not overflowing
```

### Decisions locked this session
- **Roll over excess marks** (not reset). 6/5 ranking up → `1/7`, not `0/7`. Handles a
  multi-mark turn cleanly if one ever happens.
- **Don't hard-code a per-turn mark cap.** The model *typically* awards ~1 mark/turn, but
  that's its own behavior, not a rule — an inventive play earning 2+ should just work, and the
  `while` loop already chains multiple rank-ups in a single turn if warranted.
- `marks_needed = 3 + 2*rank` per the schema comment (rank 0→3, 1→5, 2→7, 3→9, 4→11, 5→13).

## Tests to write (in `tests/`, against pure `applyCommands` / the new pass)

1. Marks below threshold → no change (4/5 stays 4/5, rank unchanged).
2. Exactly at threshold (5/5 at rank 1) → rank 2, `0/7`.
3. Over threshold rolls excess (6/5 at rank 1) → rank 2, `1/7`.
4. **Chained** rank-ups in one turn (e.g. enough marks to cross two thresholds) → lands on the
   right rank with the right leftover.
5. **Cap at 5**: a rank-5 skill fed more marks stays rank 5 with `marks` clamped to 13; the
   loop terminates (no infinite loop, no rank 6).
6. Idempotent: running the pass twice on already-settled skills is a no-op.
7. Multiple skills in one pass each roll independently.
8. Untouched skills and the rest of the tree are unaffected (deep-clone discipline like the
   other passes).

## Verify after building
- `npm test`, `npm run typecheck`, `npm run build:script`.
- Live in ST: earn marks past a threshold → dots advance one pip, `marks/marks_needed`
  resets/rolls to the new threshold, on the same turn the threshold is crossed.
