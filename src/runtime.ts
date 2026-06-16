/**
 * runtime.ts — the Tavern Helper bootstrap (the bridge that makes the pure core
 * playable inside SillyTavern). This is the one file that touches ST globals.
 *
 * Two layers, kept apart so the wiring stays unit-testable:
 *
 *   - `createRuntime(deps)` — pure-ish wiring: takes its dependencies injected, so
 *     tests can drive it with fakes (no SillyTavern, no globals). It registers the
 *     per-turn handlers and the [CURRENT STATE] injection.
 *   - `bootstrap()` at the bottom — reads the real Tavern Helper globals off
 *     `globalThis`, builds a chat-scope `VariableStore`, and calls `createRuntime`.
 *     It self-guards: outside Tavern Helper (e.g. Vitest / plain Node) it no-ops, so
 *     importing this module in a test is harmless.
 *
 * Injection mechanism (design §6): the Phase-2 preset does NOT use a `{{dungeon_state}}`
 * macro — it instructs the model to read an injected `[CURRENT STATE]` block. We push that
 * block as a persistent system injection (`injectPrompts` → `setExtensionPrompt`, keyed by a
 * stable id so re-injecting overwrites) and refresh it each turn. `formatStateBlock` already
 * emits the `[CURRENT STATE …]` header the preset looks for.
 */
import type { ApplyResult } from './applier.js';
import { makeStore, processMessage, renderInjection, type VariableStore } from './store.js';

/** Shape of a Tavern Helper prompt injection (subset of its InjectionPrompt we use). */
export interface InjectPrompt {
  id: string;
  position: 'in_chat' | 'none';
  depth: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RuntimeDeps {
  store: VariableStore;
  /** Tavern Helper `eventOn`. */
  eventOn: (event: string, listener: (...args: any[]) => void) => unknown;
  /** Tavern Helper `injectPrompts`. */
  injectPrompts: (prompts: InjectPrompt[], options?: { once?: boolean }) => unknown;
  /** The two event ids we listen on (resolved from iframe_events / tavern_events). */
  events: { GENERATION_ENDED: string; GENERATION_STARTED: string };
  /** Logger for blocked/desync notes (default no-op). */
  warn?: (msg: string) => void;
}

export interface Runtime {
  store: VariableStore;
  /** Re-render and push the [CURRENT STATE] injection from current stored state. */
  refreshInjection: () => void;
  /** Parse a generated message, apply mutations, persist, and refresh the injection. */
  onGenerationEnded: (text: string) => ApplyResult;
}

/** Stable id so re-injecting overwrites the previous block instead of stacking. */
export const INJECTION_ID = 'dungeon_state';
/** Inject near the bottom of the prompt — authoritative and recent (tune during playtest). */
export const INJECTION_DEPTH = 1;

/**
 * Wire the per-turn pipeline to injected dependencies. Pure of SillyTavern: every
 * external capability is passed in, so this is fully unit-testable.
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

  const onGenerationEnded = (text: string): ApplyResult => {
    const result = processMessage(deps.store, text, { warn });
    // Refresh so the next generation sees the freshly-applied state.
    refreshInjection();
    return result;
  };

  // GENERATION_ENDED (iframe event) hands us the full generated text directly.
  deps.eventOn(deps.events.GENERATION_ENDED, (text: string) => onGenerationEnded(text));
  // Belt-and-braces: refresh before each generation too (covers external state edits).
  deps.eventOn(deps.events.GENERATION_STARTED, () => refreshInjection());

  // Seed the very first injection now: a fresh chat has empty/seed state, and the
  // preset's chargen gate fires precisely when [CURRENT STATE] shows no character.
  refreshInjection();

  return { store: deps.store, refreshInjection, onGenerationEnded };
}

// ---------- runtime bootstrap (Tavern Helper only) ----------

/** The Tavern Helper globals the bootstrap consumes (all injected into the script iframe). */
interface TavernGlobals {
  getVariables: (opt: { type: string }) => Record<string, any>;
  replaceVariables: (vars: Record<string, any>, opt: { type: string }) => void;
  eventOn: RuntimeDeps['eventOn'];
  injectPrompts: RuntimeDeps['injectPrompts'];
  iframe_events: Record<string, string>;
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
    const toastr = g.toastr;
    const warn = (msg: string): void => {
      console.warn(msg);
      if (toastr && /^\[(BLOCKED|DESYNC)]/.test(msg)) toastr.warning(msg);
    };

    createRuntime({
      store,
      eventOn: g.eventOn!,
      injectPrompts: g.injectPrompts!,
      events: {
        GENERATION_ENDED: g.iframe_events?.GENERATION_ENDED ?? 'js_generation_ended',
        GENERATION_STARTED: g.tavern_events?.GENERATION_STARTED ?? 'generation_started',
      },
      warn,
    });
    console.info('[DungeonState] runtime initialised (chat-scope state, [CURRENT STATE] injection).');
  } catch (err) {
    console.error('[DungeonState] failed to initialise:', err);
  }
}

bootstrap();
