/**
 * commands.test.ts — M6 /map wiring. Tests the injectable `registerMapCommand` with
 * fakes (no SillyTavern): it registers under the name `map`, and its handler reads the
 * current dungeon from the store and feeds renderMap's SVG to the display sink.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerAllCommands, registerMapCommand } from '../src/commands.js';
import { makeStore } from '../src/store.js';
import { DungeonSchema, ROOT_KEY } from '../src/schema.js';

function storeWith(dungeon: unknown) {
  const vars: Record<string, any> = { [ROOT_KEY]: dungeon };
  return makeStore(
    () => vars,
    v => Object.assign(vars, v),
  );
}

describe('/map command (M6 §C)', () => {
  it('registers a `map` command and displays the rendered SVG for the current room/depth', () => {
    const dungeon = DungeonSchema.parse({
      meta: { depth: 1 },
      player: { location: 'R02' },
      rooms: {
        R01: { id: 'R01', name: 'Entry', depth: 1, exits: { east: { to: 'R02', type: 'open' } } },
        R02: { id: 'R02', name: 'Hall', depth: 1, exits: { west: { to: 'R01', type: 'open' } } },
      },
    });
    const store = storeWith(dungeon);

    let registeredName = '';
    let handler: (() => void) | undefined;
    const display = vi.fn();

    registerMapCommand({
      store,
      display,
      registerCommand: spec => {
        registeredName = spec.name;
        handler = spec.callback;
      },
    });

    expect(registeredName).toBe('map');
    expect(handler).toBeDefined();

    handler!();
    expect(display).toHaveBeenCalledOnce();
    const svg = display.mock.calls[0][0] as string;
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('DEPTH 1');
    expect(svg).toContain('data-room-id="R02"');
    expect(svg).toContain('@ YOU'); // R02 is the current room
  });

  it('renders the depth-2 map when the player has descended', () => {
    const dungeon = DungeonSchema.parse({
      meta: { depth: 2 },
      player: { location: 'R05' },
      rooms: {
        R01: { id: 'R01', name: 'Upper', depth: 1, exits: {} },
        R05: { id: 'R05', name: 'Lower', depth: 2, exits: {} },
      },
    });
    const display = vi.fn();
    let handler: (() => void) | undefined;
    registerMapCommand({
      store: storeWith(dungeon),
      display,
      registerCommand: spec => (handler = spec.callback),
    });
    handler!();
    const svg = display.mock.calls[0][0] as string;
    expect(svg).toContain('DEPTH 2');
    expect(svg).not.toContain('Upper'); // depth-1 room excluded
    expect(svg).toContain('Lower');
  });
});

describe('registerAllCommands (M8 prep)', () => {
  it('registers /map, /character and /inventory, each rendering from stored state', () => {
    const dungeon = DungeonSchema.parse({
      player: { name: 'Bramble', class: 'Cleric', location: 'R01' },
      rooms: { R01: { id: 'R01', name: 'Entry', depth: 1, exits: {} } },
      inventory: [{ id: 'mace', name: 'Iron Mace', equipped: true }],
    });
    const display = vi.fn();
    const handlers = new Map<string, () => void>();

    registerAllCommands({
      store: storeWith(dungeon),
      display,
      registerCommand: spec => handlers.set(spec.name, spec.callback),
    });

    expect([...handlers.keys()].sort()).toEqual(['character', 'inventory', 'map']);

    handlers.get('character')!();
    expect(display.mock.calls.at(-1)).toMatchObject([expect.stringContaining('Bramble'), 'Character']);

    handlers.get('inventory')!();
    expect(display.mock.calls.at(-1)).toMatchObject([expect.stringContaining('Iron Mace'), 'Inventory']);

    handlers.get('map')!();
    expect(display.mock.calls.at(-1)).toMatchObject([expect.stringContaining('<svg '), 'Automap']);
  });
});
