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
    // M6 forward-compat defaults: a bare exit grid-walks as before and reveals nothing.
    expect(r.exits.north).toEqual({
      to: 'R02',
      type: 'door',
      state: 'open',
      category: 'spatial',
      lock: 'none',
      lock_revealed: false,
    });
  });

  it('stamps the M6 forward-compat defaults (room depth, exit category/lock)', () => {
    const d = DungeonSchema.parse({
      rooms: { R01: { id: 'R01', name: 'Entry', exits: { north: { to: 'R02', type: 'door' } } } },
    });
    expect(d.rooms.R01.depth).toBe(1);
    expect(d.rooms.R01.exits.north.category).toBe('spatial');
    expect(d.rooms.R01.exits.north.lock).toBe('none');
    expect(d.rooms.R01.exits.north.lock_revealed).toBe(false);
  });

  it('accepts an undiscovered exit (to: null) and defaults a missing to to null', () => {
    const d = DungeonSchema.parse({
      rooms: {
        R01: { id: 'R01', name: 'x', exits: { south: { to: null, type: 'open' }, east: { type: 'door' } } },
      },
    });
    expect(d.rooms.R01.exits.south.to).toBeNull();
    expect(d.rooms.R01.exits.east.to).toBeNull(); // omitted → unexplored
  });

  it('validates an exit with category:portal and a discovered lock', () => {
    const parsed = DungeonSchema.safeParse({
      rooms: {
        R01: {
          id: 'R01',
          name: 'Sanctum',
          depth: 2,
          exits: {
            enter: { to: 'R09', type: 'archway', category: 'portal', lock: 'magical', lock_revealed: true },
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const e = parsed.data.rooms.R01.exits.enter;
      expect(e.category).toBe('portal');
      expect(e.lock).toBe('magical');
      expect(e.lock_revealed).toBe(true);
      expect(parsed.data.rooms.R01.depth).toBe(2);
    }
  });

  it('rejects an unknown exit category', () => {
    const bad = DungeonSchema.safeParse({
      rooms: { R01: { id: 'R01', name: 'x', exits: { north: { to: 'R02', type: 'door', category: 'diagonal' } } } },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an out-of-range skill rank', () => {
    const bad = DungeonSchema.safeParse({ player: { skills: { arcana: { rank: 9 } } } });
    expect(bad.success).toBe(false);
  });
});
