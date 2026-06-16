import { describe, expect, it } from 'vitest';
import { DungeonSchema } from '../src/schema.js';
import { loadDungeon, makeStore, processMessage } from '../src/store.js';

describe('processMessage — full per-turn pipeline', () => {
  it('parses a model message, applies mutations, and persists under the dungeon key', () => {
    let vars: Record<string, any> = {
      dungeon: DungeonSchema.parse({
        player: { hp: { cur: 10, max: 10 } },
        inventory: [{ id: 'torch', name: 'Torch', qty: 1 }],
        rooms: { R01: { id: 'R01', name: 'Entry' }, R02: { id: 'R02', name: 'Hall' } },
      }),
    };
    const store = makeStore(
      () => vars,
      v => {
        vars = v;
      },
    );

    const message = [
      'The drowned thing lunges and you stumble back, torch guttering.',
      '<UpdateDungeon>',
      "_.set('player.hp.cur', 10, 6);//drowned strike",
      "_.remove('inventory', 'torch');//burned out",
      "_.set('rooms.R01.exits.north', null, {to:'R02',type:'open'});//found a passage",
      '</UpdateDungeon>',
    ].join('\n');

    const result = processMessage(store, message);

    expect(vars.dungeon.player.hp.cur).toBe(6);
    expect(vars.dungeon.inventory).toHaveLength(0);
    expect(vars.dungeon.rooms.R01.exits.north).toMatchObject({ to: 'R02', type: 'open' });
    expect(vars.dungeon.rooms.R02.exits.south).toMatchObject({ to: 'R01' }); // reciprocal
    expect(result.delta_log.length).toBeGreaterThan(0);
    expect(result.blocked).toHaveLength(0);
  });

  it('seeds an empty dungeon when no state exists and there is no block', () => {
    const store = makeStore(
      () => ({}),
      () => {},
    );
    const result = processMessage(store, 'just prose, no mutations');
    expect(result.dungeon.meta.schema_version).toBe('2.0');
    expect(result.dungeon.player.location).toBe('R01');
  });

  it('a no-op turn (no UpdateDungeon block) preserves the prior delta_log and does not write', () => {
    let writes = 0;
    let vars: Record<string, any> = {
      dungeon: DungeonSchema.parse({ delta_log: ['prior change'], player: { hp: { cur: 8, max: 10 } } }),
    };
    const store = makeStore(
      () => vars,
      v => {
        writes++;
        vars = v;
      },
    );
    const r = processMessage(store, 'Just narration, no update block.');
    expect(loadDungeon(vars).delta_log[0]).toBe('prior change');
    expect(r.delta_log[0]).toBe('prior change');
    expect(r.blocked).toHaveLength(0);
    expect(writes).toBe(0);
  });
});

describe('loadDungeon', () => {
  it('returns a fully-defaulted tree when the dungeon key is missing', () => {
    expect(loadDungeon({}).meta.turn).toBe(0);
  });
  it('round-trips a valid stored tree', () => {
    const stored = DungeonSchema.parse({ meta: { turn: 7 } });
    expect(loadDungeon({ dungeon: stored }).meta.turn).toBe(7);
  });
  it('warns (but keeps the raw value) when stored state fails schema validation', () => {
    const warns: string[] = [];
    const broken = loadDungeon({ dungeon: { meta: { turn: 'not-a-number' } } }, m => warns.push(m));
    expect(warns.some(w => w.startsWith('[DungeonState]'))).toBe(true);
    expect((broken as any).meta.turn).toBe('not-a-number');
  });
});
