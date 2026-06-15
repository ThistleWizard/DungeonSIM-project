import { describe, expect, it } from 'vitest';
import { formatStateBlock } from '../src/inject.js';
import { DungeonSchema } from '../src/schema.js';

describe('formatStateBlock (§6 thin injection)', () => {
  it('renders the situational essentials and omits empty sections', () => {
    const d = DungeonSchema.parse({
      meta: { turn: 12, depth: 2 },
      light: { source: 'torch', ticks_remaining: 43 },
      player: {
        name: 'Brigid',
        hp: { cur: 6, max: 12 },
        defense: 12,
        skills: { Melee: { rank: 1 } },
        conditions: [{ name: 'bleeding', ticks: 3 }],
        location: 'R04',
      },
      inventory: [
        { id: 'longsword', name: 'Longsword', qty: 1, equipped: true },
        { id: 'torch', name: 'Torch', qty: 2 },
      ],
      rooms: {
        R03: { id: 'R03', name: 'Old Crypt', descr: 'should not be dumped' },
        R04: {
          id: 'R04',
          name: 'Flooded Nave',
          exits: { north: { to: 'R03', type: 'door', state: 'open' }, east: { to: 'R05', type: 'open' } },
          contents: [{ id: 'rusty_key', name: 'Rusty Key', kind: 'item' }],
        },
      },
    });

    const block = formatStateBlock(d);
    expect(block).toContain('Turn 12 | Depth 2 | Light: torch (43)');
    expect(block).toContain('You are in Flooded Nave (R04). Exits: north->R03 (door), east->R05 (open).');
    expect(block).toContain('Here: Rusty Key');
    expect(block).toContain('HP 6/12 | Defense 12 | bleeding(3)');
    expect(block).toContain('Skills: Melee 1');
    expect(block).toContain('Carrying: Longsword (equipped), Torch x2');
    // No combat → no Combat section
    expect(block).not.toContain('Combat:');
    // The full map graph is NOT dumped — only the current room's details appear.
    // Other rooms may be referenced by an exit edge, but their name/descr must not leak.
    expect(block).not.toContain('Old Crypt');
  });

  it('shows locked exit state and an active combat tracker', () => {
    const d = DungeonSchema.parse({
      player: { location: 'R01', hp: { cur: 8, max: 10 }, defense: 11 },
      rooms: { R01: { id: 'R01', name: 'Cell', exits: { north: { to: 'R02', type: 'door', state: 'locked' } } } },
      combat: {
        active: true,
        mobs: [{ id: 'rat_01', type: 'rat', name: 'Giant Rat', hp_cur: 3, hp_max: 6, status: 'bloodied', pos: 'near' }],
      },
    });
    const block = formatStateBlock(d);
    expect(block).toContain('north->R02 (door, locked)');
    expect(block).toContain('Combat:');
    expect(block).toContain('rat_01 Giant Rat HP 3/6 (bloodied) [near]');
  });

  it('handles an empty/seed dungeon without throwing', () => {
    const block = formatStateBlock(DungeonSchema.parse({}));
    expect(block).toContain('[CURRENT STATE');
    expect(block).toContain('Carrying: nothing');
  });
});
