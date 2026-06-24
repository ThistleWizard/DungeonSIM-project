# Handover — `skill-rankup` live testing

**Branch:** `skill-rankup` (PR #3 open against `main`, 3 commits ahead). Build loaded in ST is
`dist/dungeonstate.js`, rebuilt from this branch = **main + M7 + the rank-up pass together**.
**Status:** 169 tests pass, typecheck clean. The rank-up behavior is the one thing **not yet
live-verified in ST**; everything else in this build (M7 sprites/corpses/ambient, rewind delete
fix) was already verified before the PR #2 merge and just rides along.

## What changed (what to test)

### Skill rank-up rollover — NOT yet verified live (the whole point of this build)
The bug it fixes: marks accumulated to `marks_needed` and sat there full forever; the sheet's rank
dots (which track RANK, not marks) never advanced — looked like "the model missed a rank-up." The
model was never supposed to do it; the SCRIPT now rolls marks into ranks (§5 invariant 3).

Confirm in a fresh chat:
- [ ] **Normal rank-up:** earn marks until a skill crosses its threshold (`3 + 2*rank` → rank0
      needs 3, rank1 needs 5, rank2 needs 7 …). On the threshold-crossing turn, the **rank dot
      advances one pip** and `marks/marks_needed` rolls over to the new threshold (e.g. 5/5 at
      rank1 → **0/7** at rank2). Both happen the SAME turn the mark lands.
- [ ] **Excess carries:** if a turn pushes marks past the threshold (e.g. to 6 when 5 were
      needed), the leftover survives the rank-up (→ **1/7**), not reset to 0.
- [ ] **Delta log:** the turn shows a `rank up: <skill> → rank N` line (script-authored, visible).
- [ ] **(If it ever happens) big single-turn gain** chains multiple rank-ups at once and lands on
      the right rank with the right leftover.
- [ ] **Cap:** a rank-5 skill stays rank 5 and reads `13/13` — never rank 6, never overflows.

How to inspect: the `/character` sheet (rank dots + `marks/marks_needed`), or the variable display.

### Everything else in the build — already verified, just confirm no regression
M7 sprites (variety/lock/darkness), script-owned corpses + loot-on-search, ambient room light,
stack-quantity conservation, and rewind delete-then-rerun. No need to re-run the full M7 matrix;
just glance that nothing obviously broke now that rank-up rides alongside them.

## If something's wrong
Paste the failing turn's **`<UpdateDungeon>` block** and the **`delta_log`** (look for/absence of
the `rank up:` line). That isolates the layer:
- Marks not incrementing at all, or the wrong skill marked → **preset** (the model isn't emitting
  the `add player.skills.<skill>.marks` mutation): `tools/build-phase2-preset.py`, regenerate.
- Marks increment but no rank-up / wrong rollover / dots stuck → **engine**
  (`src/applier.ts` `applySkillRanks`). Unit-covered, so a live-only failure points at wiring
  (the pass runs in `applyCommands` after the command loop) or the sheet renderer
  (`src/sheet.ts`, rank dots = `'●'.repeat(rank)`).

## Next steps after live testing
- **If clean:** merge PR #3 →
  `& "C:\Program Files\GitHub CLI\gh.exe" pr merge 3 --merge`
  then mark the rank-up live-verified in `CLAUDE.md` + the roadmap memory.
- **Sprites:** the user is starting that as a FRESH session. Context lives in
  `DungeonState-dawnlike-pack-spec.md` (the DawnLike slice-tool sprite pack — the next sprite work
  item; `pack.ts` is pack-agnostic, so it's a build-time tool + generated pack, no engine change).
