/**
 * runtime.ts — the Tavern Helper bootstrap (the bridge that makes the pure core
 * playable inside SillyTavern), now with M5 rewind safety. This is the one file that
 * touches ST globals.
 *
 * Two layers, kept apart so the wiring stays unit-testable:
 *
 *   - `createRuntime(deps)` — pure-ish wiring: takes its dependencies injected, so
 *     tests can drive it with fakes (no SillyTavern, no globals). It registers the
 *     per-turn handlers, the [CURRENT STATE] injection, and the rewind snapshots.
 *   - `bootstrap()` at the bottom — reads the real Tavern Helper globals off
 *     `globalThis`, builds chat-scope + message-scope adapters, and calls
 *     `createRuntime`. It self-guards: outside Tavern Helper (e.g. Vitest / plain
 *     Node) it no-ops, so importing this module in a test is harmless.
 *
 * Apply path (M5): mutations are applied on `MESSAGE_RECEIVED` (which hands an explicit
 * message_id + type), NOT the iframe `GENERATION_ENDED` text event — so we can snapshot
 * the post-turn state onto the exact producing message/swipe and tell swipes/regens apart.
 *
 * Injection mechanism (design §6): the Phase-2 preset reads an injected `[CURRENT STATE]`
 * block (no `{{dungeon_state}}` macro). We push it as a persistent system injection
 * (`injectPrompts` → `setExtensionPrompt`, keyed by a stable id) and refresh it each turn.
 */
import type { ApplyResult } from './applier.js';
import { type Dungeon, emptyDungeon, ROOT_KEY } from './schema.js';
import { baselineBefore, type Timeline } from './rewind.js';
import { makeStore, processMessage, renderInjection, writeDungeon, type VariableStore } from './store.js';
import { bootstrapCommands } from './commands.js';

/** Shape of a Tavern Helper prompt injection (subset of its InjectionPrompt we use). */
export interface InjectPrompt {
  id: string;
  position: 'in_chat' | 'none';
  depth: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The event ids the runtime listens on (resolved from Tavern Helper's tavern_events). */
export interface RuntimeEvents {
  MESSAGE_RECEIVED: string;
  GENERATION_STARTED: string;
  MESSAGE_SWIPED: string;
  MESSAGE_DELETED: string;
}

export interface RuntimeDeps {
  store: VariableStore;
  /** Swipe-indexed message-scope snapshot access (the only ST-touching rewind surface). */
  timeline: Timeline;
  /** Read the final text of a committed message (for the apply path). */
  getMessageText: (messageId: number) => string;
  /** Tavern Helper `eventOn`. */
  eventOn: (event: string, listener: (...args: any[]) => void) => unknown;
  /** Tavern Helper `eventMakeFirst` (so swipe-restore runs before other listeners). */
  eventMakeFirst?: (event: string, listener: (...args: any[]) => void) => unknown;
  /** Tavern Helper `injectPrompts`. */
  injectPrompts: (prompts: InjectPrompt[], options?: { once?: boolean }) => unknown;
  events: RuntimeEvents;
  /** Logger for blocked/desync notes (default no-op). */
  warn?: (msg: string) => void;
}

export interface Runtime {
  store: VariableStore;
  /** Re-render and push the [CURRENT STATE] injection from current stored state. */
  refreshInjection: () => void;
  /** Apply a received message's mutations, persist, snapshot, and refresh injection. */
  onMessageReceived: (messageId: number, type: string) => ApplyResult | undefined;
  /** Reset chat scope to the pre-turn baseline before a swipe/regenerate generation. */
  onGenerationStarted: (type: string, dryRun?: boolean) => void;
  /** Restore a navigated-to swipe's snapshot into chat scope. */
  onMessageSwiped: (messageId: number) => void;
  /** Restore the new tail's snapshot after a deletion. */
  onMessageDeleted: (messageId: number) => void;
}

/** Stable id so re-injecting overwrites the previous block instead of stacking. */
export const INJECTION_ID = 'dungeon_state';
/** Inject near the bottom of the prompt — authoritative and recent (tune during playtest). */
export const INJECTION_DEPTH = 1;

/**
 * Generation `type`s that must NOT drive a state apply: out-of-band or partial outputs
 * whose text isn't a normal turn emission. Everything else is processed.
 */
const SKIP_RECEIVED_TYPES = new Set(['quiet', 'impersonate', 'continue', 'append', 'appendFinal']);

/**
 * Wire the per-turn pipeline + rewind to injected dependencies. Pure of SillyTavern:
 * every external capability is passed in, so this is fully unit-testable.
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const warn = deps.warn ?? (() => {});

  const refreshInjection = (): void => {
    deps.injectPrompts([
      {
        id: INJECTION_ID,
        position: 'in_chat',
        depth: INJECTION_DEPTH,
        role: 'system',
        content: renderInjection(deps.store, warn),
      },
    ]);
  };

  const onMessageReceived = (messageId: number, type: string): ApplyResult | undefined => {
    if (SKIP_RECEIVED_TYPES.has(type)) return undefined;
    const result = processMessage(deps.store, deps.getMessageText(messageId), { warn });
    // Snapshot the post-turn state onto this exact message/swipe so the timeline owns it.
    deps.timeline.writeSnapshot(messageId, result.dungeon);
    refreshInjection();
    return result;
  };

  const onGenerationStarted = (type: string, dryRun = false): void => {
    if (dryRun) return;
    // A swipe-generate or regenerate re-rolls the LAST message: roll chat scope back to
    // the pre-turn baseline (the preceding message's snapshot) so deltas don't double-apply.
    if (type === 'swipe' || type === 'regenerate') {
      const baseline = baselineBefore(deps.timeline, deps.timeline.lastIndex()) ?? emptyDungeon();
      writeDungeon(deps.store, baseline);
    }
    refreshInjection();
  };

  const onMessageSwiped = (messageId: number): void => {
    const snap = deps.timeline.readSnapshot(messageId);
    if (snap === undefined) return; // empty new swipe → GENERATION_STARTED('swipe') resets baseline
    writeDungeon(deps.store, snap);
    refreshInjection();
  };

  const onMessageDeleted = (_messageId: number): void => {
    const snap = deps.timeline.readSnapshot('latest');
    if (snap === undefined) return;
    writeDungeon(deps.store, snap);
    refreshInjection();
  };

  deps.eventOn(deps.events.MESSAGE_RECEIVED, (id: unknown, type: unknown) =>
    onMessageReceived(Number(id), String(type ?? 'normal')),
  );
  deps.eventOn(deps.events.GENERATION_STARTED, (type: unknown, _opt: unknown, dryRun: unknown) =>
    onGenerationStarted(String(type ?? ''), Boolean(dryRun)),
  );
  // Restore-on-swipe should run before other listeners read chat scope.
  (deps.eventMakeFirst ?? deps.eventOn)(deps.events.MESSAGE_SWIPED, (id: unknown) => onMessageSwiped(Number(id)));
  deps.eventOn(deps.events.MESSAGE_DELETED, (id: unknown) => onMessageDeleted(Number(id)));

  // Seed the very first injection now: a fresh chat has empty/seed state, and the
  // preset's chargen gate fires precisely when [CURRENT STATE] shows no character.
  refreshInjection();

  return {
    store: deps.store,
    refreshInjection,
    onMessageReceived,
    onGenerationStarted,
    onMessageSwiped,
    onMessageDeleted,
  };
}

// ---------- runtime bootstrap (Tavern Helper only) ----------

/** A Tavern Helper message-scope variable option. */
type MessageOption = { type: 'message'; message_id: number | 'latest' };
type ChatOption = { type: 'chat' };

/** The Tavern Helper globals the bootstrap consumes (all injected into the script iframe). */
interface TavernGlobals {
  getVariables: (opt: ChatOption | MessageOption) => Record<string, any>;
  replaceVariables: (vars: Record<string, any>, opt: ChatOption | MessageOption) => void;
  getChatMessages: (range: string | number, options?: any) => Array<{ message?: string }>;
  getLastMessageId: () => number;
  eventOn: RuntimeDeps['eventOn'];
  eventMakeFirst: RuntimeDeps['eventOn'];
  injectPrompts: RuntimeDeps['injectPrompts'];
  tavern_events: Record<string, string>;
  toastr?: { warning: (msg: string) => void };
}

function bootstrap(): void {
  const g = globalThis as unknown as Partial<TavernGlobals>;
  // Not inside Tavern Helper (unit tests / plain Node): do nothing.
  if (typeof g.getVariables !== 'function' || typeof g.eventOn !== 'function') return;

  try {
    const store = makeStore(
      () => g.getVariables!({ type: 'chat' }),
      v => g.replaceVariables!(v, { type: 'chat' }),
    );

    const timeline: Timeline = {
      lastIndex: () => (typeof g.getLastMessageId === 'function' ? g.getLastMessageId() : -1),
      readSnapshot: (messageId): Dungeon | undefined => {
        try {
          const vars = g.getVariables!({ type: 'message', message_id: messageId });
          const snap = vars?.[ROOT_KEY];
          return snap === undefined ? undefined : (snap as Dungeon);
        } catch {
          return undefined; // out-of-range / no variables yet
        }
      },
      writeSnapshot: (messageId, dungeon): void => {
        const vars = g.getVariables!({ type: 'message', message_id: messageId });
        vars[ROOT_KEY] = dungeon;
        g.replaceVariables!(vars, { type: 'message', message_id: messageId });
      },
    };

    const getMessageText = (messageId: number): string => g.getChatMessages?.(messageId)?.[0]?.message ?? '';

    const toastr = g.toastr;
    const warn = (msg: string): void => {
      console.warn(msg);
      if (toastr && /^\[(BLOCKED|DESYNC)]/.test(msg)) toastr.warning(msg);
    };

    const te = g.tavern_events ?? {};
    createRuntime({
      store,
      timeline,
      getMessageText,
      eventOn: g.eventOn!,
      eventMakeFirst: g.eventMakeFirst,
      injectPrompts: g.injectPrompts!,
      events: {
        MESSAGE_RECEIVED: te.MESSAGE_RECEIVED ?? 'message_received',
        GENERATION_STARTED: te.GENERATION_STARTED ?? 'generation_started',
        MESSAGE_SWIPED: te.MESSAGE_SWIPED ?? 'message_swiped',
        MESSAGE_DELETED: te.MESSAGE_DELETED ?? 'message_deleted',
      },
      warn,
    });
    // M6+: register the player-facing view commands (/map, /character, /inventory).
    bootstrapCommands(store, warn);
    console.info(
      '[DungeonState] runtime initialised (chat-scope state, message-scope rewind, [CURRENT STATE] injection, /map /character /inventory).',
    );
  } catch (err) {
    console.error('[DungeonState] failed to initialise:', err);
  }
}

bootstrap();
