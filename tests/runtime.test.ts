import { describe, expect, it } from 'vitest';
import { DungeonSchema } from '../src/schema.js';
import { makeStore, type VariableStore } from '../src/store.js';
import { INJECTION_ID, createRuntime, type InjectPrompt } from '../src/runtime.js';

const EVENTS = { GENERATION_ENDED: 'js_generation_ended', GENERATION_STARTED: 'generation_started' };

/** A harness that captures registered handlers and the latest injection. */
function harness(initialVars: Record<string, any> = {}) {
  let vars = initialVars;
  let writes = 0;
  const store: VariableStore = makeStore(
    () => vars,
    v => {
      writes++;
      vars = v;
    },
  );

  const handlers = new Map<string, (...args: any[]) => void>();
  const injections: InjectPrompt[] = [];

  const runtime = createRuntime({
    store,
    eventOn: (event, listener) => handlers.set(event, listener),
    injectPrompts: prompts => injections.push(...prompts),
    events: EVENTS,
    warn: () => {},
  });

  return {
    runtime,
    handlers,
    injections,
    lastInjection: () => injections[injections.length - 1],
    getVars: () => vars,
    writeCount: () => writes,
    emitGenerationEnded: (text: string) => handlers.get(EVENTS.GENERATION_ENDED)!(text),
    emitGenerationStarted: () => handlers.get(EVENTS.GENERATION_STARTED)!(),
  };
}

describe('createRuntime — wiring', () => {
  it('registers handlers for both events and seeds an initial injection', () => {
    const h = harness();
    expect(h.handlers.has(EVENTS.GENERATION_ENDED)).toBe(true);
    expect(h.handlers.has(EVENTS.GENERATION_STARTED)).toBe(true);
    // One injection pushed at construction.
    expect(h.injections).toHaveLength(1);
    expect(h.lastInjection()).toMatchObject({ id: INJECTION_ID, position: 'in_chat', role: 'system' });
    expect(h.lastInjection().content).toContain('[CURRENT STATE');
  });

  it('applies an <UpdateDungeon> block on GENERATION_ENDED, persists, and refreshes injection', () => {
    const h = harness({
      dungeon: DungeonSchema.parse({
        player: { hp: { cur: 10, max: 10 } },
        rooms: { R01: { id: 'R01', name: 'Entry' } },
      }),
    });

    const message = [
      'The bolt catches you in the shoulder.',
      '<UpdateDungeon>',
      "_.set('player.hp.cur', 10, 6);//crossbow",
      "_.add('meta.turn', 1);//tick",
      '</UpdateDungeon>',
    ].join('\n');

    h.emitGenerationEnded(message);

    expect(h.getVars().dungeon.player.hp.cur).toBe(6);
    expect(h.getVars().dungeon.meta.turn).toBe(1);
    expect(h.writeCount()).toBe(1);
    // A fresh injection reflecting the new state was pushed (initial + this one).
    expect(h.injections.length).toBeGreaterThanOrEqual(2);
    expect(h.lastInjection().content).toContain('HP 6/10');
  });

  it('a no-op turn (no block) preserves prior delta_log and does not write', () => {
    const h = harness({
      dungeon: DungeonSchema.parse({ delta_log: ['prior change'], player: { hp: { cur: 8, max: 10 } } }),
    });

    const result = h.runtime.onGenerationEnded('Pure narration, nothing changes.');

    expect(result.delta_log[0]).toBe('prior change');
    expect(result.blocked).toHaveLength(0);
    expect(h.getVars().dungeon.delta_log[0]).toBe('prior change');
    expect(h.writeCount()).toBe(0); // no-op short-circuits the write (store.ts Fix 3)
  });

  it('refreshInjection on GENERATION_STARTED re-renders from current state', () => {
    const h = harness({ dungeon: DungeonSchema.parse({ player: { hp: { cur: 4, max: 10 } } }) });
    const before = h.injections.length;
    h.emitGenerationStarted();
    expect(h.injections.length).toBe(before + 1);
    expect(h.lastInjection().content).toContain('HP 4/10');
  });
});
