import { describe, expect, it } from 'vitest';
import { DungeonSchema, type Dungeon } from '../src/schema.js';
import { loadDungeon, makeStore } from '../src/store.js';
import { createRuntime, type InjectPrompt } from '../src/runtime.js';
import type { Timeline } from '../src/rewind.js';

const EVENTS = {
  MESSAGE_RECEIVED: 'message_received',
  GENERATION_STARTED: 'generation_started',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_DELETED: 'message_deleted',
};

const upd = (...lines: string[]) => ['narration', '<UpdateDungeon>', ...lines, '</UpdateDungeon>'].join('\n');
const seedHp = (hp: number): Dungeon =>
  DungeonSchema.parse({ player: { hp: { cur: hp, max: 10 } }, rooms: { R01: { id: 'R01', name: 'Entry' } } });

/** A swipe-indexed in-memory Timeline that mirrors chat[i].variables[swipe_id]. */
class FakeTimeline implements Timeline {
  private snaps: (Dungeon | undefined)[][] = [];
  private swipe: number[] = [];
  private last = -1;

  lastIndex() {
    return this.last;
  }
  setLast(i: number) {
    this.last = i;
    return this;
  }
  private ensure(i: number) {
    if (!this.snaps[i]) {
      this.snaps[i] = [undefined];
      this.swipe[i] = 0;
    }
  }
  /** Simulate the user moving message `i` to swipe `s` (creating it if new). */
  navigate(i: number, s: number) {
    this.ensure(i);
    while (this.snaps[i].length <= s) this.snaps[i].push(undefined);
    this.swipe[i] = s;
  }
  readSnapshot(id: number | 'latest') {
    const i = id === 'latest' ? this.last : id;
    if (i < 0 || !this.snaps[i]) return undefined;
    return this.snaps[i][this.swipe[i]];
  }
  writeSnapshot(i: number, d: Dungeon) {
    this.ensure(i);
    this.snaps[i][this.swipe[i]] = d;
    if (i > this.last) this.last = i;
  }
}

function harness(seed?: Dungeon) {
  let chatVars: Record<string, any> = seed ? { dungeon: seed } : {};
  const store = makeStore(
    () => chatVars,
    v => {
      chatVars = v;
    },
  );
  const tl = new FakeTimeline();
  const text = new Map<number, string>();
  const injections: InjectPrompt[] = [];

  const rt = createRuntime({
    store,
    timeline: tl,
    getMessageText: id => text.get(id) ?? '',
    setMessageText: (id, t) => text.set(id, t),
    eventOn: () => {},
    eventMakeFirst: () => {},
    injectPrompts: p => injections.push(...p),
    events: EVENTS,
    warn: () => {},
  });

  return {
    rt,
    tl,
    text,
    injections,
    hp: () => loadDungeon(chatVars).player.hp.cur,
    dungeon: () => loadDungeon(chatVars),
    lastInjection: () => injections[injections.length - 1].content,
  };
}

/** Mid-game setup: a prior AI turn at index 1 left the dungeon at hp 10 (chat scope matches). */
function midGame() {
  const h = harness(seedHp(10));
  h.tl.navigate(1, 0);
  h.tl.writeSnapshot(1, seedHp(10));
  return h;
}

describe('createRuntime — wiring', () => {
  it('registers handlers for the four timeline events and seeds one injection', () => {
    const registered: string[] = [];
    let injected = 0;
    createRuntime({
      store: makeStore(
        () => ({}),
        () => {},
      ),
      timeline: new FakeTimeline(),
      getMessageText: () => '',
      eventOn: e => registered.push(e),
      eventMakeFirst: e => registered.push(e),
      injectPrompts: () => {
        injected++;
      },
      events: EVENTS,
    });
    expect(registered.sort()).toEqual(
      ['generation_started', 'message_deleted', 'message_received', 'message_swiped'].sort(),
    );
    expect(injected).toBe(1);
  });
});

describe('apply path — MESSAGE_RECEIVED', () => {
  it('applies, persists, snapshots onto the message, and refreshes injection', () => {
    const h = harness(seedHp(10));
    h.text.set(1, upd("_.set('player.hp.cur', 10, 6);//hit", "_.add('meta.turn', 1);//tick"));
    const r = h.rt.onMessageReceived(1, 'normal')!;
    expect(h.hp()).toBe(6);
    expect(r.dungeon.meta.turn).toBe(1);
    expect(h.tl.readSnapshot(1)!.player.hp.cur).toBe(6);
    expect(h.lastInjection()).toContain('HP 6/10');
  });

  it('embeds the script-rendered footer into the message, before the mutation block', () => {
    const h = harness(seedHp(10));
    h.text.set(1, upd("_.add('player.hp.cur', -4);//hit", "_.add('meta.turn', 1);//tick"));
    h.rt.onMessageReceived(1, 'normal');
    const out = h.text.get(1)!;
    expect(out).toContain('Exits: '); // footer rendered from applied state
    expect(out.indexOf('<!--ds-footer-->')).toBeLessThan(out.indexOf('<UpdateDungeon>'));
    // Re-applying the same message must not stack footers (idempotent).
    h.rt.onMessageReceived(1, 'normal');
    expect((h.text.get(1)!.match(/ds-footer/g) ?? []).length).toBe(2);
  });

  it('skips out-of-band generation types (quiet/impersonate/continue)', () => {
    const h = midGame();
    h.text.set(2, upd("_.add('player.hp.cur', -4);//should be ignored"));
    expect(h.rt.onMessageReceived(2, 'quiet')).toBeUndefined();
    expect(h.hp()).toBe(10);
  });

  it('a no-op turn snapshots current state and preserves delta_log', () => {
    const h = harness(DungeonSchema.parse({ delta_log: ['prior'], player: { hp: { cur: 8, max: 10 } } }));
    const r = h.rt.onMessageReceived(1, 'normal')!; // no text → no <UpdateDungeon>
    expect(r.delta_log[0]).toBe('prior');
    expect(h.dungeon().delta_log[0]).toBe('prior');
    expect(h.tl.readSnapshot(1)!.player.hp.cur).toBe(8);
  });
});

describe('rewind — regenerate / swipe / delete', () => {
  it('regenerate rolls back to the pre-turn baseline (no double-apply)', () => {
    const h = midGame();
    h.text.set(2, upd("_.add('player.hp.cur', -4);//first roll"));
    h.rt.onMessageReceived(2, 'normal');
    expect(h.hp()).toBe(6);

    // Regenerate message 2 with a different (-3) hit.
    h.rt.onGenerationStarted('regenerate'); // baseline = snapshot@1 (hp 10) → chat hp 10
    expect(h.hp()).toBe(10);
    h.text.set(2, upd("_.add('player.hp.cur', -3);//different roll"));
    h.rt.onMessageReceived(2, 'regenerate');

    expect(h.hp()).toBe(7); // 10 - 3, NOT 6 - 3 and NOT 10 - 4 - 3
    expect(h.tl.readSnapshot(2)!.player.hp.cur).toBe(7);
  });

  it('swipe-generate uses the pre-turn baseline; navigating swipes restores each branch', () => {
    const h = midGame();
    h.text.set(2, upd("_.add('player.hp.cur', -4);//swipe 0"));
    h.rt.onMessageReceived(2, 'normal');
    expect(h.hp()).toBe(6);

    // User swipes right to a fresh empty swipe, then generates it.
    h.tl.navigate(2, 1);
    h.rt.onMessageSwiped(2); // empty → no-op (baseline handled at generation start)
    h.rt.onGenerationStarted('swipe');
    expect(h.hp()).toBe(10);
    h.text.set(2, upd("_.add('player.hp.cur', -3);//swipe 1"));
    h.rt.onMessageReceived(2, 'swipe');
    expect(h.hp()).toBe(7);

    // Navigate back to swipe 0, then forward to swipe 1 — each restores its own state.
    h.tl.navigate(2, 0);
    h.rt.onMessageSwiped(2);
    expect(h.hp()).toBe(6);
    h.tl.navigate(2, 1);
    h.rt.onMessageSwiped(2);
    expect(h.hp()).toBe(7);
  });

  it('deleting the tail restores the previous turn snapshot', () => {
    const h = midGame();
    h.text.set(2, upd("_.add('player.hp.cur', -4);//hit"));
    h.rt.onMessageReceived(2, 'normal');
    expect(h.hp()).toBe(6);

    h.tl.setLast(1); // message 2 removed
    h.rt.onMessageDeleted(2);
    expect(h.hp()).toBe(10);
  });

  it('a normal forward turn needs no baseline reset', () => {
    const h = midGame();
    h.rt.onGenerationStarted('normal'); // must NOT touch chat scope
    expect(h.hp()).toBe(10);
  });
});
