import { describe, expect, it } from 'vitest';
import { DungeonSchema, emptyDungeon } from '../src/schema.js';

describe('DungeonSchema (M1)', () => {
  it('produces a fully-defaulted valid tree from {}', () => {
    const d = emptyDungeon();
    expect(d.meta.turn).toBe(0);
    expect(d.meta.schema_version).toBe('2.0');
    expect(d.player.hp).toEqual({ cur: 10, max: 10 });
    expect(d.player.location).toBe('R01');
    expect(d.rooms).toEqual({});
    expect(d.combat.active).toBe(false);
    expect(d.delta_log).toEqual([]);
    expect(d.light).toBeNull();
  });

  it('applies room and exit defaults on partial input', () => {
    const d = DungeonSchema.parse({
      rooms: { R01: { id: 'R01', name: 'Entry', exits: { north: { to: 'R02', type: 'door' } } } },
    });
    const r = d.rooms.R01;
    expect(r.visited).toBe(true);
    expect(r.contents).toEqual([]);
    expect(r.effects).toEqual([]);
    expect(r.exits.north).toEqual({ to: 'R02', type: 'door', state: 'open' });
  });

  it('rejects an out-of-range skill rank', () => {
    const bad = DungeonSchema.safeParse({ player: { skills: { arcana: { rank: 9 } } } });
    expect(bad.success).toBe(false);
  });
});
