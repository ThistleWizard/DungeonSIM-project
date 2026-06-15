/**
 * store.ts — runtime glue for M3, behind an injectable interface so it stays
 * unit-testable without SillyTavern.
 *
 * `processMessage` is the full per-turn pipeline: read chat-scope variables →
 * parse the model's <UpdateDungeon> block → apply with invariants → write back.
 *
 * The actual ST wiring is a tiny adapter (kept out of the testable core):
 *
 *   const store = makeStore(
 *     () => getVariables({ type: 'chat' }),
 *     v  => replaceVariables(v, { type: 'chat' }),
 *   );
 *   eventOn(tavern_events.GENERATION_ENDED, () =>
 *     processMessage(store, getLastMessageText(), { warn: console.warn }));
 */
import { applyCommands, type ApplyOptions, type ApplyResult } from './applier.js';
import { extractCommands } from './parser.js';
import { type Dungeon, DungeonSchema, ROOT_KEY, emptyDungeon } from './schema.js';

export interface VariableStore {
  read(): Record<string, any>;
  write(vars: Record<string, any>): void;
}

export function makeStore(read: () => Record<string, any>, write: (vars: Record<string, any>) => void): VariableStore {
  return { read, write };
}

/** Load and normalise the dungeon subtree from a raw variables object. */
export function loadDungeon(vars: Record<string, any>): Dungeon {
  const raw = vars?.[ROOT_KEY];
  if (raw === undefined || raw === null) return emptyDungeon();
  const parsed = DungeonSchema.safeParse(raw);
  // Best-effort: if stored state is currently invalid, keep it rather than wipe a
  // run; the applier tolerates it and the next valid turn re-normalises.
  return parsed.success ? parsed.data : (raw as Dungeon);
}

/**
 * Full per-turn pipeline. Reads variables from the store, applies the mutations
 * found in `message`, persists the result back under the `dungeon` key, and
 * returns the structured ApplyResult.
 */
export function processMessage(store: VariableStore, message: string, opts: ApplyOptions = {}): ApplyResult {
  const vars = store.read() ?? {};
  const current = loadDungeon(vars);
  const commands = extractCommands(message);
  const result = applyCommands(current, commands, opts);
  vars[ROOT_KEY] = result.dungeon;
  store.write(vars);
  return result;
}
