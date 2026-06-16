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
 *
 * And the §6 injection (preset references it as {{dungeon_state}}):
 *
 *   registerMacroLike(/{{dungeon_state}}/g, () => renderInjection(store));
 *   // or inject at low depth on GENERATION_STARTED via Tavern Helper's inject API.
 */
import { applyCommands, type ApplyOptions, type ApplyResult } from './applier.js';
import { formatStateBlock } from './inject.js';
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
export function loadDungeon(vars: Record<string, any>, warn?: (m: string) => void): Dungeon {
  const raw = vars?.[ROOT_KEY];
  if (raw === undefined || raw === null) return emptyDungeon();
  const parsed = DungeonSchema.safeParse(raw);
  // Best-effort: if stored state is currently invalid, keep it rather than wipe a
  // run; the applier tolerates it and the next valid turn re-normalises. But log
  // it — silent validation loss is also the migration trigger (see §13 / patch §4).
  if (!parsed.success) {
    warn?.(
      `[DungeonState] stored state failed schema validation (kept as-is): ${parsed.error.issues
        .slice(0, 3)
        .map(i => i.path.join('.') + ': ' + i.message)
        .join('; ')}`,
    );
    return raw as Dungeon;
  }
  return parsed.data;
}

/**
 * Full per-turn pipeline. Reads variables from the store, applies the mutations
 * found in `message`, persists the result back under the `dungeon` key, and
 * returns the structured ApplyResult.
 */
export function processMessage(store: VariableStore, message: string, opts: ApplyOptions = {}): ApplyResult {
  const vars = store.read() ?? {};
  const current = loadDungeon(vars, opts.warn);
  const commands = extractCommands(message);
  if (commands.length === 0) {
    // No <UpdateDungeon> block this turn (pure dialogue / OOC): do not clear the
    // delta_log or rewrite. A no-op must preserve the previous turn's change list
    // so lazy consumers (map render, "what changed") can still read it.
    return { dungeon: current, delta_log: current.delta_log ?? [], blocked: [], desync: [] };
  }
  const result = applyCommands(current, commands, opts);
  vars[ROOT_KEY] = result.dungeon;
  store.write(vars);
  return result;
}

/** Render the compact [CURRENT STATE] block for prompt injection (design §6). */
export function renderInjection(store: VariableStore, warn?: (m: string) => void): string {
  return formatStateBlock(loadDungeon(store.read() ?? {}, warn));
}
