import { describe, expect, it } from 'vitest';
import { applyCommands } from '../src/applier.js';
import { DungeonSchema, emptyDungeon } from '../src/schema.js';
import type { Command, CommandType } from '../src/types.js';

const cmd = (type: CommandType, path: string, args: unknown[] = [], reason = ''): Command => ({
  type,
  path,
  args,
  reason,
  raw: '',
});

const base = () =>
  DungeonSchema.parse({
    player: { hp: { cur: 8, max: 10 } },
    light: { source: 'torch', ticks_remaining: 5 },
    inventory: [
      { id: 'torch', name: 'Torch', qty: 2 },
      { id: 'key', name: 'Rusty Key', qty: 1 },
    ],
    rooms: {
      R01: { id: 'R01', name: 'Entry', exits: { north: { to: 'R02', type: 'door', state: 'locked' } } },
      R02: { id: 'R02', name: 'Hall' },
    },
  });

describe('applyCommands — id-keyed array addressing', () => {
  it('sets a field on an inventory item addressed by id', () => {
    const r = applyCommands(base(), [cmd('set', 'inventory.key.equipped', [false, true], 'wield the key?')]);
    const key = r.dungeon.inventory.find(i => i.id === 'key')!;
    expect(key.equipped).toBe(true);
    expect(r.blocked).toEqual([]);
  });

  it('decrements charges on a specific item via add', () => {
    const d = DungeonSchema.parse({
      inventory: [{ id: 'wand', name: 'Wand of Sparks', qty: 1, charges: 5 }],
    });
    const r = applyCommands(d, [cmd('add', 'inventory.wand.charges', [-1], 'zap')]);
    expect(r.dungeon.inventory[0].charges).toBe(4);
  });

  it('assigns multiple fields to an item at once', () => {
    const r = applyCommands(base(), [cmd('assign', 'inventory.torch', [{ equipped: true, notes: 'held aloft' }])]);
    const torch = r.dungeon.inventory.find(i => i.id === 'torch')!;
    expect(torch.equipped).toBe(true);
    expect(torch.notes).toBe('held aloft');
    expect(torch.qty).toBe(2); // untouched
  });

  it('blocks (does not corrupt) a path whose id is not present', () => {
    const warns: string[] = [];
    const r = applyCommands(base(), [cmd('set', 'inventory.flute.equipped', [null, true])], {
      warn: m => warns.push(m),
    });
    expect(r.blocked).toHaveLength(1);
    expect(r.dungeon.inventory).toHaveLength(2); // tree intact, no junk key created
    expect((r.dungeon.inventory as any).flute).toBeUndefined();
    expect(warns.join()).toMatch(/no array item matching/);
  });

  it('clamps mob hp addressed by mob id (resolution makes the clamp fire)', () => {
    const d = DungeonSchema.parse({
      combat: {
        active: true,
        mobs: [{ id: 'drowned_01', type: 'drowned', name: 'Drowned', hp_cur: 6, hp_max: 8 }],
      },
    });
    const r = applyCommands(d, [cmd('add', 'combat.mobs.drowned_01.hp_cur', [-99])]);
    expect(r.dungeon.combat.mobs[0].hp_cur).toBe(0); // clamped to [0, max], not -93
  });

  it('still consumes a stacked item via remove(id, n) — the torch idiom', () => {
    const r = applyCommands(base(), [cmd('remove', 'inventory', ['torch', 1], 'lit one torch')]);
    const torch = r.dungeon.inventory.find(i => i.id === 'torch')!;
    expect(torch.qty).toBe(1);
    expect(r.blocked).toEqual([]);
  });
});

describe('applyCommands — purity & bookkeeping', () => {
  it('never mutates its input', () => {
    const input = base();
    const snapshot = structuredClone(input);
    applyCommands(input, [cmd('set', 'player.hp.cur', [8, 1]), cmd('unset', 'rooms.R01')]);
    expect(input).toEqual(snapshot);
  });

  it('clears delta_log at the start of the turn by default', () => {
    const d = DungeonSchema.parse({ delta_log: ['stale'], player: { hp: { cur: 8, max: 10 } } });
    const r = applyCommands(d, [cmd('add', 'player.hp.cur', [-1])]);
    expect(r.delta_log).not.toContain('stale');
    const kept = applyCommands(d, [cmd('add', 'player.hp.cur', [-1])], { clearDeltaLog: false });
    expect(kept.delta_log).toContain('stale');
  });

  it('routes blocked/desync notes to the injected warn callback', () => {
    const warns: string[] = [];
    applyCommands(base(), [cmd('unset', 'rooms.R01'), cmd('set', 'player.hp.cur', [999, 1])], {
      warn: m => warns.push(m),
    });
    expect(warns.some(w => w.startsWith('[BLOCKED]'))).toBe(true);
    expect(warns.some(w => w.startsWith('[DESYNC]'))).toBe(true);
  });
});

describe('invariant 4 — old-value confirmation', () => {
  it('applies a set whose claimed old value matches, no desync', () => {
    const r = applyCommands(base(), [cmd('set', 'player.hp.cur', [8, 5], 'hit')]);
    expect(r.dungeon.player.hp.cur).toBe(5);
    expect(r.desync).toHaveLength(0);
    expect(r.delta_log.some(l => l.includes('player.hp.cur'))).toBe(true);
  });

  it('flags desync on mismatch but still applies the new value', () => {
    const r = applyCommands(base(), [cmd('set', 'player.hp.cur', [3, 5])]);
    expect(r.dungeon.player.hp.cur).toBe(5);
    expect(r.desync).toHaveLength(1);
  });
});

describe('invariant 3 — numeric bounds', () => {
  it('clamps hp.cur to [0, max] via add', () => {
    expect(applyCommands(base(), [cmd('add', 'player.hp.cur', [-100])]).dungeon.player.hp.cur).toBe(0);
  });
  it('clamps hp.cur to max via set', () => {
    expect(applyCommands(base(), [cmd('set', 'player.hp.cur', [8, 999])]).dungeon.player.hp.cur).toBe(10);
  });
  it('clamps combat mob hp_cur', () => {
    const d = DungeonSchema.parse({
      combat: { active: true, mobs: [{ id: 'm1', type: 'rat', name: 'Rat', hp_cur: 5, hp_max: 6 }] },
    });
    const r = applyCommands(d, [cmd('add', 'combat.mobs[0].hp_cur', [-99])]);
    expect(r.dungeon.combat.mobs[0].hp_cur).toBe(0);
  });
  it('blocks add on a non-numeric target', () => {
    expect(applyCommands(base(), [cmd('add', 'player.name', [1])]).blocked).toHaveLength(1);
  });
  it('initialises a missing numeric path to 0 (first use-based mark)', () => {
    const r = applyCommands(emptyDungeon(), [cmd('add', 'player.skills.lockpicking.marks', [1], 'first use')]);
    expect(r.blocked).toHaveLength(0);
    expect(r.dungeon.player.skills.lockpicking.marks).toBe(1);
  });
  it('clamps mob hp_cur to 0 on overkill via set, and via add', () => {
    const base = emptyDungeon();
    base.combat.active = true;
    base.combat.mobs = [{ id: 'm1', type: 'x', name: 'x', hp_cur: 8, hp_max: 8, status: '', pos: 'near' }] as any;
    const overkill = applyCommands(base, [cmd('set', 'combat.mobs.0.hp_cur', [8, -3], 'overkill')]);
    expect(overkill.dungeon.combat.mobs[0].hp_cur).toBe(0);
    const hit = applyCommands(base, [cmd('add', 'combat.mobs.0.hp_cur', [-5], 'hit')]);
    expect(hit.dungeon.combat.mobs[0].hp_cur).toBe(3);
  });
});

describe('invariant 1 — topology lock', () => {
  it('adds a new exit and auto-writes the reciprocal edge', () => {
    const r = applyCommands(base(), [cmd('set', 'rooms.R01.exits.east', [null, { to: 'R02', type: 'open' }])]);
    expect(r.blocked).toHaveLength(0);
    expect(r.dungeon.rooms.R01.exits.east).toMatchObject({ to: 'R02', type: 'open' });
    expect(r.dungeon.rooms.R02.exits.west).toMatchObject({ to: 'R01', type: 'open' });
  });

  it('does not flag a desync when adding a new path (claimed null vs stored undefined)', () => {
    const r = applyCommands(base(), [cmd('set', 'rooms.R01.exits.east', [null, { to: 'R02', type: 'open' }])]);
    expect(r.desync).toHaveLength(0);
  });

  it('mirrors stairs type on the reciprocal edge', () => {
    const r = applyCommands(base(), [cmd('set', 'rooms.R01.exits.down', [null, { to: 'R02', type: 'stairs_down' }])]);
    expect(r.dungeon.rooms.R02.exits.up).toMatchObject({ to: 'R01', type: 'stairs_up' });
  });

  it('does not auto-link when the target room does not exist yet', () => {
    const r = applyCommands(base(), [cmd('set', 'rooms.R01.exits.east', [null, { to: 'R99', type: 'open' }])]);
    expect(r.dungeon.rooms.R99).toBeUndefined();
    expect(r.dungeon.rooms.R01.exits.east).toBeDefined();
  });

  it('blocks redirecting/replacing an existing exit', () => {
    const r = applyCommands(base(), [cmd('set', 'rooms.R01.exits.north', [null, { to: 'R03', type: 'open' }])]);
    expect(r.blocked).toHaveLength(1);
    expect(r.dungeon.rooms.R01.exits.north.to).toBe('R02');
  });

  it('discovers an unexplored exit (to:null → room id) and auto-writes the reciprocal', () => {
    const d = DungeonSchema.parse({
      rooms: { R01: { id: 'R01', name: 'Entry', exits: { south: { to: null, type: 'open' } } } },
    });
    // Player goes south: create the new room, then fill in the unexplored exit's destination.
    const r = applyCommands(d, [
      cmd('assign', 'rooms.R02', [{ id: 'R02', name: 'Hall', exits: {} }]),
      cmd('set', 'rooms.R01.exits.south.to', [null, 'R02'], 'discovered south'),
    ]);
    expect(r.blocked).toEqual([]);
    expect(r.dungeon.rooms.R01.exits.south.to).toBe('R02');
    expect(r.dungeon.rooms.R02.exits.north).toMatchObject({ to: 'R01', type: 'open' }); // reciprocal
  });

  it('blocks editing exit.to and exit.type, allows exit.state', () => {
    expect(applyCommands(base(), [cmd('set', 'rooms.R01.exits.north.to', ['R02', 'R09'])]).blocked).toHaveLength(1);
    expect(applyCommands(base(), [cmd('set', 'rooms.R01.exits.north.type', ['door', 'open'])]).blocked).toHaveLength(1);
    const ok = applyCommands(base(), [cmd('set', 'rooms.R01.exits.north.state', ['locked', 'open'], 'picked')]);
    expect(ok.blocked).toHaveLength(0);
    expect(ok.dungeon.rooms.R01.exits.north.state).toBe('open');
  });

  it('blocks deleting an exit', () => {
    expect(applyCommands(base(), [cmd('unset', 'rooms.R01.exits.north')]).blocked).toHaveLength(1);
    expect(applyCommands(base(), [cmd('delete', 'rooms.R01.exits.north')]).blocked).toHaveLength(1);
  });
});

describe('invariant 5 — append-only rooms & bestiary', () => {
  it('blocks mutating an immutable field of an existing room', () => {
    const r = applyCommands(base(), [cmd('set', 'rooms.R01.name', ['Entry', 'Foyer'])]);
    expect(r.blocked).toHaveLength(1);
    expect(r.dungeon.rooms.R01.name).toBe('Entry');
  });
  it('allows whitelisted room subfields (visited, contents)', () => {
    expect(applyCommands(base(), [cmd('set', 'rooms.R01.visited', [true, true])]).blocked).toHaveLength(0);
    expect(
      applyCommands(base(), [cmd('insert', 'rooms.R01.contents', [{ id: 'gem', name: 'Gem', kind: 'item' }])]).dungeon
        .rooms.R01.contents,
    ).toHaveLength(1);
  });
  it('allows appending a new room, blocks deleting one', () => {
    const r = applyCommands(base(), [cmd('set', 'rooms.R03', [null, { id: 'R03', name: 'Crypt' }])]);
    expect(r.blocked).toHaveLength(0);
    expect(r.dungeon.rooms.R03.name).toBe('Crypt');
    expect(applyCommands(base(), [cmd('unset', 'rooms.R01')]).blocked).toHaveLength(1);
  });
  it('enforces bestiary immutability but allows new entries', () => {
    const d = DungeonSchema.parse({ bestiary: { drowned: { sprite_fragment: 'x', hp_base: 8, defense: 11 } } });
    expect(applyCommands(d, [cmd('set', 'bestiary.drowned.hp_base', [8, 99])]).blocked).toHaveLength(1);
    expect(
      applyCommands(d, [cmd('set', 'bestiary.rat', [null, { sprite_fragment: 'y', hp_base: 3, defense: 9 }])]).blocked,
    ).toHaveLength(0);
  });
});

describe('invariant 2 — inventory legality', () => {
  it('decrements a stack and splices when it hits zero', () => {
    const r1 = applyCommands(base(), [cmd('remove', 'inventory', ['torch'], 'burned one')]);
    expect(r1.dungeon.inventory.find(i => i.id === 'torch')?.qty).toBe(1);
    const r2 = applyCommands(base(), [cmd('remove', 'inventory', ['key'])]);
    expect(r2.dungeon.inventory.find(i => i.id === 'key')).toBeUndefined();
  });
  it('blocks removing an item that is not present', () => {
    expect(applyCommands(base(), [cmd('remove', 'inventory', ['sword'])]).blocked).toHaveLength(1);
  });
  it('blocks removing more than the held quantity', () => {
    expect(applyCommands(base(), [cmd('remove', 'inventory', ['key', 5])]).blocked).toHaveLength(1);
  });
  // Regression: conditions/effects key off `name`, not `id` (matching resolvePath). A spell
  // wearing off — `_.remove('player.conditions', 'Shield')` — must succeed, not BLOCK.
  it('removes a condition by name (not id)', () => {
    const d = DungeonSchema.parse({
      player: { conditions: [{ name: 'Shield', ticks: 4 }, { name: 'Blessed', ticks: null }] },
    });
    const r = applyCommands(d, [cmd('remove', 'player.conditions', ['Shield'], 'spell expired')]);
    expect(r.blocked).toHaveLength(0);
    expect(r.dungeon.player.conditions.map(c => c.name)).toEqual(['Blessed']);
  });
});

describe('other verbs', () => {
  it('unsets a non-protected path (id-resolved)', () => {
    const r = applyCommands(base(), [cmd('unset', 'inventory.key.notes', [], 'clear note')]);
    expect(r.dungeon.inventory.find(i => i.id === 'key')!.notes).toBeUndefined();
    expect(r.blocked).toHaveLength(0);
  });
});

describe('light economy (script-owned) + move', () => {
  const lit = () =>
    DungeonSchema.parse({
      meta: { turn: 0 },
      player: { location: 'R01' },
      inventory: [
        { id: 'torch_1', name: 'Torch', fuel: 60, lit: true },
        { id: 'torch_2', name: 'Torch', fuel: 60, lit: false },
      ],
      rooms: { R01: { id: 'R01', name: 'Cell', contents: [] } },
    });

  it('derives `light` from the lit carried torch (model never writes light)', () => {
    const r = applyCommands(lit(), [cmd('add', 'meta.turn', [1])]);
    expect(r.dungeon.light).toEqual({ source: 'Torch', ticks_remaining: 59 }); // burned 1 tick
  });

  it('burns fuel by the turn-delta, including a time-skip', () => {
    const r = applyCommands(lit(), [cmd('add', 'meta.turn', [10])]);
    expect(r.dungeon.inventory.find(i => i.id === 'torch_1')!.fuel).toBe(50);
  });

  it('snuffing (lit→false) goes dark; relighting resumes from frozen fuel', () => {
    const snuffed = applyCommands(lit(), [
      cmd('set', 'inventory.torch_1.lit', [true, false]),
      cmd('add', 'meta.turn', [1]),
    ]);
    expect(snuffed.dungeon.light).toBeNull(); // genuinely dark
    expect(snuffed.dungeon.inventory.find(i => i.id === 'torch_1')!.fuel).toBe(60); // frozen, not ticked
    const relit = applyCommands(snuffed.dungeon, [
      cmd('set', 'inventory.torch_1.lit', [false, true]),
      cmd('add', 'meta.turn', [1]),
    ]);
    expect(relit.dungeon.light).toEqual({ source: 'Torch', ticks_remaining: 59 });
  });

  it('a torch that burns to 0 is spent and removed, and the scene goes dark', () => {
    const d = DungeonSchema.parse({
      meta: { turn: 0 },
      player: { location: 'R01' },
      inventory: [{ id: 'torch_1', name: 'Torch', fuel: 3, lit: true }],
      rooms: { R01: { id: 'R01', name: 'Cell', contents: [] } },
    });
    const r = applyCommands(d, [cmd('add', 'meta.turn', [5])]);
    expect(r.dungeon.inventory).toHaveLength(0);
    expect(r.dungeon.light).toBeNull();
  });

  it('move relocates a lit torch to the room floor, fuel intact, and it still lights the room', () => {
    const r = applyCommands(lit(), [
      cmd('move', 'inventory.torch_1', ['rooms.R01.contents'], 'set it down'),
      cmd('add', 'meta.turn', [1]),
    ]);
    expect(r.dungeon.inventory.find(i => i.id === 'torch_1')).toBeUndefined(); // left the pack
    const onFloor = r.dungeon.rooms.R01.contents.find(i => i.id === 'torch_1')!;
    expect(onFloor.lit).toBe(true);
    expect(onFloor.fuel).toBe(59); // still burning on the floor
    expect(r.dungeon.light).toEqual({ source: 'Torch', ticks_remaining: 59 }); // lights the room you're in
  });

  it('move un-equips the object and blocks a non-array destination', () => {
    const d = DungeonSchema.parse({
      player: { location: 'R01' },
      inventory: [{ id: 'mace', name: 'Mace', equipped: true }],
      rooms: { R01: { id: 'R01', name: 'Cell', contents: [] } },
    });
    const ok = applyCommands(d, [cmd('move', 'inventory.mace', ['rooms.R01.contents'])]);
    expect(ok.dungeon.rooms.R01.contents.find(i => i.id === 'mace')!.equipped).toBe(false);
    const bad = applyCommands(d, [cmd('move', 'inventory.mace', ['rooms.R01'])]);
    expect(bad.blocked).toHaveLength(1); // destination is not an array
  });
});

describe('skill rank-up rollover (script-owned)', () => {
  // marks_needed = 3 + 2*rank → rank 0:3, 1:5, 2:7, 3:9, 4:11, 5:13.
  const withSkills = (skills: Record<string, { rank?: number; marks?: number; marks_needed?: number }>) =>
    DungeonSchema.parse({ player: { skills } });
  const skill = (r: ReturnType<typeof applyCommands>, name: string) => r.dungeon.player.skills[name];

  it('leaves a skill below its threshold untouched', () => {
    const r = applyCommands(withSkills({ melee: { rank: 1, marks: 4, marks_needed: 5 } }), []);
    expect(skill(r, 'melee')).toEqual({ rank: 1, marks: 4, marks_needed: 5 });
  });

  it('ranks up and rolls the excess to 0 when exactly at threshold', () => {
    const r = applyCommands(withSkills({ melee: { rank: 1, marks: 5, marks_needed: 5 } }), []);
    expect(skill(r, 'melee')).toEqual({ rank: 2, marks: 0, marks_needed: 7 });
  });

  it('carries the excess marks over a rank-up', () => {
    const r = applyCommands(withSkills({ melee: { rank: 1, marks: 6, marks_needed: 5 } }), []);
    expect(skill(r, 'melee')).toEqual({ rank: 2, marks: 1, marks_needed: 7 });
  });

  it('chains multiple rank-ups in a single pass (3→r1, 5→r2, 7→r3)', () => {
    const r = applyCommands(withSkills({ melee: { rank: 0, marks: 20, marks_needed: 3 } }), []);
    expect(skill(r, 'melee')).toEqual({ rank: 3, marks: 5, marks_needed: 9 }); // 20-3-5-7=5, 5<9
  });

  it('caps at rank 5 and clamps marks to 13/13, terminating cleanly', () => {
    const r = applyCommands(withSkills({ melee: { rank: 4, marks: 100, marks_needed: 11 } }), []);
    expect(skill(r, 'melee')).toEqual({ rank: 5, marks: 13, marks_needed: 13 });
  });

  it('is idempotent — a second pass over settled skills changes nothing', () => {
    const r1 = applyCommands(withSkills({ melee: { rank: 1, marks: 6, marks_needed: 5 } }), []);
    const r2 = applyCommands(r1.dungeon, []);
    expect(r2.dungeon.player.skills).toEqual(r1.dungeon.player.skills);
  });

  it('rolls each skill independently in one pass', () => {
    const r = applyCommands(
      withSkills({
        melee: { rank: 1, marks: 5, marks_needed: 5 }, // → rank 2, 0/7
        stealth: { rank: 0, marks: 1, marks_needed: 3 }, // unchanged
      }),
      [],
    );
    expect(skill(r, 'melee')).toEqual({ rank: 2, marks: 0, marks_needed: 7 });
    expect(skill(r, 'stealth')).toEqual({ rank: 0, marks: 1, marks_needed: 3 });
  });

  it('composes with the model add: a mark that crosses the threshold ranks up the same turn', () => {
    const d = withSkills({ melee: { rank: 1, marks: 4, marks_needed: 5 } });
    const r = applyCommands(d, [cmd('add', 'player.skills.melee.marks', [1], 'a telling blow')]);
    expect(skill(r, 'melee')).toEqual({ rank: 2, marks: 0, marks_needed: 7 });
    expect(r.delta_log.some(l => /rank up: melee/.test(l))).toBe(true);
  });

  it('tolerates an ad-hoc skill created by add (no rank/marks_needed): treats it as rank 0', () => {
    const r = applyCommands(emptyDungeon(), [cmd('add', 'player.skills.lockpicking.marks', [1], 'first use')]);
    expect(r.blocked).toHaveLength(0);
    expect(skill(r, 'lockpicking')).toEqual({ rank: 0, marks: 1, marks_needed: 3 });
  });
});

describe('move with a count (partial take/drop, script-owned conservation)', () => {
  const stocked = () =>
    DungeonSchema.parse({
      player: { location: 'R01' },
      inventory: [],
      rooms: {
        R01: { id: 'R01', name: 'Storeroom', contents: [{ id: 'clay_jar', name: 'Clay Jar', qty: 3 }] },
      },
    });

  it('takes N of a stack: source decrements, destination gets exactly N (total conserved)', () => {
    const r = applyCommands(stocked(), [cmd('move', 'rooms.R01.contents.clay_jar', ['inventory', 1])]);
    expect(r.dungeon.rooms.R01.contents.find(i => i.id === 'clay_jar')!.qty).toBe(2); // 3 - 1
    expect(r.dungeon.inventory.find(i => i.id === 'clay_jar')!.qty).toBe(1);
    // conservation: 2 in room + 1 in pack = the original 3, never inflated to 4
    expect(r.dungeon.rooms.R01.contents.find(i => i.id === 'clay_jar')!.qty + r.dungeon.inventory[0].qty).toBe(3);
  });

  it('a second partial take MERGES into the existing pack stack (no duplicate id)', () => {
    const once = applyCommands(stocked(), [cmd('move', 'rooms.R01.contents.clay_jar', ['inventory', 1])]);
    const twice = applyCommands(once.dungeon, [cmd('move', 'rooms.R01.contents.clay_jar', ['inventory', 1])]);
    expect(twice.dungeon.inventory.filter(i => i.id === 'clay_jar')).toHaveLength(1); // merged, not duped
    expect(twice.dungeon.inventory.find(i => i.id === 'clay_jar')!.qty).toBe(2);
    expect(twice.dungeon.rooms.R01.contents.find(i => i.id === 'clay_jar')!.qty).toBe(1);
  });

  it('a count >= the stack moves the whole object (source entry removed)', () => {
    const r = applyCommands(stocked(), [cmd('move', 'rooms.R01.contents.clay_jar', ['inventory', 3])]);
    expect(r.dungeon.rooms.R01.contents.find(i => i.id === 'clay_jar')).toBeUndefined();
    expect(r.dungeon.inventory.find(i => i.id === 'clay_jar')!.qty).toBe(3);
  });

  it('blocks a count of 0 or above the stack (never over-moves or inflates)', () => {
    const zero = applyCommands(stocked(), [cmd('move', 'rooms.R01.contents.clay_jar', ['inventory', 0])]);
    expect(zero.blocked).toHaveLength(1);
    expect(zero.dungeon.inventory).toHaveLength(0); // nothing moved
    const over = applyCommands(stocked(), [cmd('move', 'rooms.R01.contents.clay_jar', ['inventory', 5])]);
    expect(over.blocked).toHaveLength(1);
    expect(over.dungeon.rooms.R01.contents.find(i => i.id === 'clay_jar')!.qty).toBe(3); // untouched
  });

  it('a count is ignored for a light source — the whole lit torch moves with fuel intact', () => {
    const d = DungeonSchema.parse({
      player: { location: 'R01' },
      inventory: [{ id: 'torch_1', name: 'Torch', fuel: 40, lit: true }],
      rooms: { R01: { id: 'R01', name: 'Cell', contents: [] } },
    });
    const r = applyCommands(d, [cmd('move', 'inventory.torch_1', ['rooms.R01.contents', 1])]);
    expect(r.dungeon.inventory.find(i => i.id === 'torch_1')).toBeUndefined(); // whole torch left
    const onFloor = r.dungeon.rooms.R01.contents.find(i => i.id === 'torch_1')!;
    expect(onFloor.lit).toBe(true);
    expect(onFloor.fuel).toBe(40); // not split, fuel intact
  });
});

describe('ambient room light (script-owned)', () => {
  const ambient = (light = 'a shaft of pale daylight') =>
    DungeonSchema.parse({
      meta: { turn: 0 },
      player: { location: 'R01' },
      inventory: [],
      rooms: { R01: { id: 'R01', name: 'Threshold', contents: [], ambient_light: light } },
    });

  it('lights the room with no torch and no ticks (null = fuel-less)', () => {
    const r = applyCommands(ambient(), [cmd('add', 'meta.turn', [1])]);
    expect(r.dungeon.light).toEqual({ source: 'a shaft of pale daylight', ticks_remaining: null });
  });

  it('never counts down across a time-skip', () => {
    const r = applyCommands(ambient(), [cmd('add', 'meta.turn', [50])]);
    expect(r.dungeon.light).toEqual({ source: 'a shaft of pale daylight', ticks_remaining: null });
  });

  it('an empty ambient_light string is an ordinary dark room', () => {
    const r = applyCommands(ambient(''), [cmd('add', 'meta.turn', [1])]);
    expect(r.dungeon.light).toBeNull();
  });

  it('a carried lit torch (with fuel/ticks) takes precedence over ambient light', () => {
    const d = DungeonSchema.parse({
      meta: { turn: 0 },
      player: { location: 'R01' },
      inventory: [{ id: 'torch_1', name: 'Torch', fuel: 60, lit: true }],
      rooms: { R01: { id: 'R01', name: 'Threshold', contents: [], ambient_light: 'lava glow' } },
    });
    const r = applyCommands(d, [cmd('add', 'meta.turn', [1])]);
    expect(r.dungeon.light).toEqual({ source: 'Torch', ticks_remaining: 59 });
  });
});

describe('death resolution (script-owned corpses)', () => {
  const fight = (status = '') =>
    DungeonSchema.parse({
      player: { location: 'R01' },
      rooms: { R01: { id: 'R01', name: 'Crypt', contents: [] } },
      combat: {
        active: true,
        mobs: [
          { id: 'goblin_1', type: 'goblin', name: 'Goblin', hp_cur: 0, hp_max: 8, status },
          { id: 'goblin_2', type: 'goblin', name: 'Goblin', hp_cur: 5, hp_max: 8 },
        ],
      },
    });

  it("a mob marked status:'dead' becomes a corpse in the current room and leaves combat", () => {
    const r = applyCommands(fight(), [cmd('set', 'combat.mobs.goblin_1.status', ['', 'dead'])]);
    expect(r.dungeon.combat.mobs.map(m => m.id)).toEqual(['goblin_2']); // dead mob removed
    const corpse = r.dungeon.rooms.R01.contents.find(c => c.id === 'goblin_1_corpse')!;
    expect(corpse).toBeDefined();
    expect(corpse.kind).toBe('corpse');
    expect(corpse.name).toBe('Goblin corpse');
  });

  it('the fresh corpse carries no enumerated loot (lazy reveal at search time)', () => {
    const r = applyCommands(fight(), [cmd('set', 'combat.mobs.goblin_1.status', ['', 'dead'])]);
    const corpse = r.dungeon.rooms.R01.contents.find(c => c.id === 'goblin_1_corpse')!;
    expect(corpse.notes).toBe('');
    expect(r.dungeon.rooms.R01.contents).toHaveLength(1); // only the body, nothing else
  });

  it('fleeing/despawn via _.remove leaves NO corpse', () => {
    const r = applyCommands(fight(), [cmd('remove', 'combat.mobs', ['goblin_1'])]);
    expect(r.dungeon.combat.mobs.map(m => m.id)).toEqual(['goblin_2']);
    expect(r.dungeon.rooms.R01.contents).toHaveLength(0); // no body — it fled
  });

  it('is idempotent — re-applying does not duplicate the corpse', () => {
    const once = applyCommands(fight(), [cmd('set', 'combat.mobs.goblin_1.status', ['', 'dead'])]);
    // Re-introduce a same-id dead mob; the existing corpse must not be duplicated.
    const seeded = DungeonSchema.parse({
      ...once.dungeon,
      combat: {
        active: true,
        mobs: [{ id: 'goblin_1', type: 'goblin', name: 'Goblin', hp_cur: 0, hp_max: 8, status: 'dead' }],
      },
    });
    const twice = applyCommands(seeded, []);
    expect(twice.dungeon.rooms.R01.contents.filter(c => c.id === 'goblin_1_corpse')).toHaveLength(1);
  });
});
