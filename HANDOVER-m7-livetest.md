# Handover — `m7-sprites` live testing

**Branch:** `m7-sprites` (off `main` @ `b0bfacb`; **local only, not pushed**). `main` untouched.
**Commits:**
- `2d21dc8` feat(m7): sprite system + ambient light, script-owned corpses, stack conservation
- `37e1a2e` fix(rewind): roll back past snapshotless user messages on delete

**Status:** 159 tests pass, typecheck clean, preset regenerated, `dist/dungeonstate.js` rebuilt.
Everything below is unit-tested; the **live behavior in SillyTavern is what still needs confirming.**

## Before testing — load the build
1. Reload the script bundle `dist/dungeonstate.js` into SillyTavern (see `LOADING.md`).
2. **Re-import the preset** `DungeonSIM-Phase2.json` (the prompt rules changed — bestiary tags,
   ambient light, kill/corpse, quantity conservation). Old imported copy won't have them.
3. Start a **fresh chat** for clean chargen.

## What changed this session (what to test)

### 1. M7 sprites — PARTIALLY verified
Already confirmed live: a silhouette appears in the display viewport for a faced mob, and the
sprite **stays locked across swipes**. Still to confirm:
- [ ] Two mobs of the **same type** in one fight get **different** silhouettes (hash variety),
      and each stays stable turn-to-turn.
- [ ] A descriptor shifts the art (e.g. an `armored` humanoid vs a plain one looks different).
- [ ] Darkness / no mob faced → viewport shows the placeholder, no sprite.

### 2. Ambient room light — start confirmed, rest open
Confirmed: the **starting room is lit** without a torch. Still to confirm:
- [ ] The first-room narration **hints** the player's torches are unlit and the dark beyond is total.
- [ ] A model-authored room with its own light (sunlit shrine, lava glow) reads as **lit with no
      torch**; its `Light:` line shows the described source (no "(N left)" ticks).
- [ ] An ordinary new room is **dark** until a torch is lit.

### 3. Script-owned corpses + lazy loot — confirmed spawning, confirm the rest
Confirmed: items spawn into `Here:` as described. Still to confirm:
- [ ] On a **kill**, the mob leaves combat and a `<Name> corpse` appears in `Here:` / the display,
      with **no loot on it yet**.
- [ ] **Searching** the body is what reveals loot as takeable objects in the room.
- [ ] A mob that **flees** (vs. dies) leaves **no** corpse.

### 4. Stack quantity conservation — NOT yet verified live (most important)
This is the one most likely to still misbehave — the reveal path is **preset-only** (the engine
can't enforce it; see below).
- [ ] **Reveal:** examine a stack (e.g. `clay_jars x3`), declare one holds salt → result must be
      **2 plain jars + 1 salt jar = 3 total**, NOT 4. (This was the bug: the model inserted salt
      without decrementing the jars.)
- [ ] **Partial take:** take 1 of a stack of 3 → room drops to 2, pack gains 1 (no duplicate id,
      no inflation). This path IS engine-backed (`_.move` with a count), so it should be solid.

### 5. Rewind on delete — FIXED this session, re-verify
The earlier "delete verified live" was incomplete; deleting an AI turn whose predecessor is your
user command used to leave that turn's mutations in chat scope.
- [ ] Do a turn that changes the room (take an item / reveal loot / take damage), **delete** the
      AI message, **re-run** the same command → the state must roll back to **before** that turn
      (the re-run must NOT see the deleted turn's changes — no lingering `jar_salt`, correct HP,
      correct room contents).
- [ ] Spot-check swipe and regenerate still roll back correctly (shared baseline logic).

## If something's still wrong
Paste the failing turn's **`<UpdateDungeon>` block** (and the `[CURRENT STATE]` it saw if visible).
That's enough to tell which layer to fix:
- Wrong/missing mutation the model should have emitted → **preset** (`tools/build-phase2-preset.py`,
  then `python tools/build-phase2-preset.py` to regenerate the JSON; never hand-edit the JSON).
- State applied wrong / not rolled back / corrupted → **engine** (`src/applier.ts`, `src/runtime.ts`).

## Known limitation worth a decision
Quantity conservation on the **reveal** path (declaring one of a stack is something specific)
**cannot** be enforced by the script — nothing tells the engine the new item came out of the stack;
that link lives only in the fiction. It's a preset rule (with a worked clay-jar example). If live
play shows the model still forgets the decrement, the escalation is a dedicated atomic
`_.split('<stack>', n, {<new item>})` verb (decrement + insert in one command) — **not built yet**;
spec it only if the rule proves insufficient.

## Next steps after live testing
- If clean: push `m7-sprites`, open a PR, and mark M7 + the engine additions live-verified in
  `CLAUDE.md` (and update the M5 note to record the delete fix).
- Still parked: `resolution-philosophy` (the §17 preset tuning) — will conflict with this branch's
  preset generator on merge; rebase, take both `.py` edits, regenerate the JSON.
