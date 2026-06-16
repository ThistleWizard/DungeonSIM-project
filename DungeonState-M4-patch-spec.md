# DungeonState — M4 review patch spec
*Drop-in fixes after the M1–M4 review. 67 tests passed (parser R1–R11, schema, all five §5 invariants, end-to-end). The architecture is sound; these are 5 targeted fixes + 2 missing tests. Fix #1 and #3 before the next long playtest. Each item: file, exact change, test to add.*

---

## Fix 1 — `add` to a not-yet-existing numeric path (REAL BUG, fix first)
**File:** `applier.ts`, `applyAdd`.
**Problem:** `_.add('player.skills.lockpicking.marks', 1)` on an untrained skill returns `undefined` from `_.get`, which the current guard rejects as "not a number". But the FIRST mark in an untrained skill is the most common advancement case — use-based growth starts from rank 0. Right now every first-use mark gets silently blocked.
**Change:** treat a missing (`undefined`) stored value as `0` for `add`, so the delta initialises it. Keep rejecting a stored value that exists but is non-numeric (a real type error).
```ts
function applyAdd(d: Dungeon, cmd: Command, ctx: Ctx): void {
  const { path } = cmd;
  const delta = cmd.args[0];
  if (typeof delta !== 'number') return ctx.block(cmd, `add delta '${fmt(delta)}' is not a number`);
  const guard = guardWrite(d, path, undefined, 'write');
  if (!guard.allowed) return ctx.block(cmd, guard.reason!);
  const stored = _.get(d, path);
  const baseVal = stored === undefined ? 0 : stored;      // NEW: missing => 0
  if (typeof baseVal !== 'number') return ctx.block(cmd, `add target '${path}' is not a number (${fmt(stored)})`);
  const finalV = clampForPath(d, path, baseVal + delta);
  _.set(d, path, finalV);
  ctx.log(`${path}: ${baseVal} -> ${finalV}${reasonSuffix(cmd)}`);
}
```
**Caveat to consider:** this means a typo path like `_.add('player.hp.curr', 1)` (note the typo) will silently create `player.hp.curr = 1` instead of blocking. Acceptable tradeoff for now, but if you want belt-and-braces, restrict the `undefined => 0` behaviour to paths matching `/\.marks$/` or a small allowlist. Recommend the simple version first; tighten only if stray paths show up in delta_log during play.
**Test to add (`test_applier.ts`):**
```ts
let r = run(emptyDungeon(), `_.add('player.skills.lockpicking.marks',1);//first use`);
check('add initialises missing numeric to 0', _.get(r.dungeon,'player.skills.lockpicking.marks')===1, JSON.stringify(r.blocked));
```

## Fix 2 — missing coverage on the mob-HP clamp (TEST GAP, not a bug)
**File:** `test_applier.ts` (add test). `applier.ts` is probably correct but untested on this path.
**Why:** `clampForPath` handles `combat.mobs.<i>.hp_cur` using `seg[2]` as the index. From a lodash path `'combat.mobs.0.hp_cur'`, `_.toPath` gives `['combat','mobs','0','hp_cur']`, so `seg[2]==='0'` (string) — `_.get(d,['combat','mobs','0','hp_max'])` works, but confirm it.
**Test to add:**
```ts
let base = emptyDungeon();
base.combat.active = true;
base.combat.mobs = [{id:'m1',type:'x',name:'x',hp_cur:8,hp_max:8,status:'',pos:'near'}];
let r = run(base, `_.set('combat.mobs.0.hp_cur',8,-3);//overkill`);
check('mob hp clamps to 0', r.dungeon.combat.mobs[0].hp_cur===0, String(r.dungeon.combat.mobs[0].hp_cur));
r = run(base, `_.add('combat.mobs.0.hp_cur',-5);//hit`);
check('mob hp add clamps', r.dungeon.combat.mobs[0].hp_cur===3, String(r.dungeon.combat.mobs[0].hp_cur));
```
If either fails, the index handling in `clampForPath` needs `Number(seg[2])` or to read `hp_max` via the full sibling path — fix then.

## Fix 3 — no-op turn wipes delta_log (ROBUSTNESS, fix before playtest)
**File:** `store.ts`, `processMessage`.
**Problem:** a turn with no `<UpdateDungeon>` block yields `commands=[]`, but `applyCommands` still clears `delta_log` and writes back. A pure-dialogue or OOC turn therefore erases the previous turn's change list before any lazy UI (map render, "what changed") can read it.
**Change:** when no commands parsed, skip the apply/write entirely and return a no-op result preserving existing state.
```ts
export function processMessage(store: VariableStore, message: string, opts: ApplyOptions = {}): ApplyResult {
  const vars = store.read() ?? {};
  const current = loadDungeon(vars);
  const commands = extractCommands(message);
  if (commands.length === 0) {
    // No mutations this turn: do not clear delta_log, do not rewrite. No-op.
    return { dungeon: current, delta_log: current.delta_log ?? [], blocked: [], desync: [] };
  }
  const result = applyCommands(current, commands, opts);
  vars[ROOT_KEY] = result.dungeon;
  store.write(vars);
  return result;
}
```
**Test to add (`test_e2e.ts`):**
```ts
// seed a delta_log, then a no-op turn must preserve it
vars.dungeon.delta_log = ['prior change'];
const r = processMessage(store, 'Just narration, no update block.', {});
check('no-op preserves delta_log', loadDungeon(vars).delta_log[0]==='prior change');
check('no-op returns empty blocked', r.blocked.length===0);
```

## Fix 4 — `loadDungeon` fails silently on invalid stored state (OBSERVABILITY)
**File:** `store.ts`, `loadDungeon`.
**Problem:** the best-effort "keep raw if safeParse fails" is the right call (don't wipe a run), but it's silent. Drift or a future schema change will stop validation invisibly. You want to SEE it — it's also your migration trigger (see save-state note below).
**Change:** accept an optional warn callback and log on parse failure. Keep returning raw.
```ts
export function loadDungeon(vars: Record<string, any>, warn?: (m: string) => void): Dungeon {
  const raw = vars?.[ROOT_KEY];
  if (raw === undefined || raw === null) return emptyDungeon();
  const parsed = DungeonSchema.safeParse(raw);
  if (!parsed.success) {
    warn?.(`[DungeonState] stored state failed schema validation (kept as-is): ${parsed.error.issues.slice(0,3).map(i=>i.path.join('.')+': '+i.message).join('; ')}`);
    return raw as Dungeon;
  }
  return parsed.data;
}
```
Thread `console.warn` through from `processMessage`/`renderInjection` at runtime. No new test required; optionally assert the warn fires on a deliberately-broken input.

## Fix 5 — `move` verb: remove from preset vocabulary (CONSISTENCY)
**Not a code change to the applier** (blocking `move` cleanly is correct). Instead: ensure the PRESET never tells the model to emit `_.move(...)`, or every use becomes a `[BLOCKED]` log entry that clutters delta_log and wastes a mutation.
**Action:** in the DungeonSIM-MVU preset's mutation-syntax instructions, list allowed verbs as `set, add, insert, assign, remove, unset` only. Drop `move` and `delete` (delete is redundant with unset; keep the applier alias but don't advertise it). Revisit `move` only if a concrete need appears (e.g. transfer item between containers) — then implement it as remove+insert in one guarded op.

---

## Save-state / crash recovery (answer to the standing question)
**Already safe — no work needed for basic recovery.** State lives in ST `chat` scope, which Tavern Helper persists to `chat_metadata` in the chat's on-disk JSON, written every turn by `store.write()` → `replaceVariables({type:'chat'})`. A server crash loses at most the in-progress (never-completed, never-written) turn; reload restores the last completed turn. This is strictly more robust than the Phase-1 prose ledger. Per-turn writes are whole-subtree (atomic), so no torn-write risk.

**Two optional later enhancements (NOT now):**
- *Manual snapshot/export command* — dump `dungeon` to downloadable JSON. Value is branching/retry (save before a risky descent), not crash recovery. Mild tension with permadeath ethos — taste call.
- *Schema-version migration* — `meta.schema_version` exists; when the §13 TTRPG layer adds fields, old saved chats carry old-shaped state. A migration keyed on `schema_version` up-converts on load. Fix #4's logging is the prerequisite: it's how you'll SEE that an old save stopped validating and needs migration. Build the migration only when you first change the schema shape.

**M5 (rewind) note:** message-scope swipe snapshots persist to disk fine too, but introduce a *consistency* (not data-loss) question — a crash mid-swipe could leave chat-scope state ahead of the message you resume on. Handle in the M5 restore logic; test it then.
