/**
 * display.test.ts — the M8 Gold Box panel. The mount/widget/ST-DOM wiring is the guarded
 * `bootstrapDisplay` (no-ops under Vitest, like runtime's bootstrap); here we test the PURE
 * `renderDisplay` / `renderViewport`: that all four tiles render from state, the responsive
 * chrome is present, and the active tab is honoured.
 */
import { describe, expect, it } from 'vitest';
import { renderDisplay, renderViewport } from '../src/display.js';
import { DungeonSchema } from '../src/schema.js';

function world() {
  return DungeonSchema.parse({
    meta: { depth: 1 },
    light: { source: 'Torch', ticks_remaining: 30 }, // lit → the viewport scene shows the room
    player: { name: 'Bramble', class: 'Cleric', location: 'R01', hp: { cur: 9, max: 16 } },
    rooms: { R01: { id: 'R01', name: 'Entry Hall', depth: 1, exits: {} } },
    inventory: [{ id: 'mace', name: 'Iron Mace', equipped: true }],
  });
}

describe('renderDisplay (M8)', () => {
  const html = renderDisplay(world());

  it('assembles all four tiles from state', () => {
    expect(html).toContain('<svg '); // map
    expect(html).toContain('Bramble'); // character sheet
    expect(html).toContain('9 / 16'); // sheet HP
    expect(html).toContain('Iron Mace'); // inventory
    expect(html).toContain('Viewport'); // viewport tile (panel title; CSS uppercases it)
    expect(html).toContain('Entry Hall'); // viewport scene caption shows the current (lit) room
  });

  it('emits the responsive chrome: scoped style, a 2×2 container query, tab bar + tiles', () => {
    expect(html).toContain('.ds-display');
    expect(html).toContain('@container (min-width:480px)');
    expect(html).toContain('grid-template-columns:1fr 1fr'); // quadrants when wide
    expect(html).toContain('class="ds-tabs"');
    expect(html.match(/class="ds-tab[ "]/g)?.length).toBe(4); // four tab buttons
    expect(html.match(/class="ds-tile/g)?.length).toBe(4); // four tiles
  });

  it('marks the default tab (map) active, and honours an explicit activeTab', () => {
    // The map tab + tile carry ds-active by default.
    expect(html).toMatch(/class="ds-tab ds-active" data-tab="map"/);
    expect(html).toMatch(/class="ds-tile ds-active" data-tab="map"/);
    const onChar = renderDisplay(world(), { activeTab: 'character' });
    expect(onChar).toMatch(/class="ds-tab ds-active" data-tab="character"/);
    expect(onChar).not.toMatch(/class="ds-tab ds-active" data-tab="map"/);
  });

  it('is deterministic', () => {
    expect(renderDisplay(world())).toBe(renderDisplay(world()));
  });

  // The map follows the player's CURRENT ROOM depth, not meta.depth — so a level change
  // renders correctly even if meta.depth bookkeeping lags. Player is on depth 2 while
  // meta.depth is still a stale 1; the map must still place + highlight the current room.
  it('renders the level of the room the player is in, not stale meta.depth', () => {
    const twoLevels = DungeonSchema.parse({
      meta: { depth: 1 }, // stale: player descended but meta.depth not updated
      light: { source: 'Torch', ticks_remaining: 20 },
      player: { name: 'Tam', location: 'R02', hp: { cur: 6, max: 6 } },
      rooms: {
        R01: { id: 'R01', name: 'Upper Hall', depth: 1, exits: {} },
        R02: { id: 'R02', name: 'Cistern Landing', depth: 2, exits: {} },
      },
    });
    const html = renderDisplay(twoLevels);
    expect(html).toContain('@ YOU'); // current room is on the rendered level (would be absent if depth 1 drawn)
    expect(html).toContain('R02');
  });
});

describe('renderViewport (M8 stand-in until M7 sprites)', () => {
  it('shows the current room when not in combat, with the M7 sprite slot', () => {
    const html = renderViewport(world());
    expect(html).toContain('Entry Hall');
    expect(html).toContain('data-viewport'); // the scene window
    expect(html).toContain('data-sprite-slot'); // M7 fills this with the sprite
    expect(html).toContain('[sprite: M7]');
  });

  it('shows the faced mob (name + HP) during combat', () => {
    const d = DungeonSchema.parse({
      light: { source: 'Torch', ticks_remaining: 30 }, // lit → mob is visible (dark would conceal)
      combat: {
        active: true,
        mobs: [{ id: 'drowned_01', type: 'drowned', name: 'Drowned Thrall', hp_cur: 5, hp_max: 12 }],
      },
    });
    const html = renderViewport(d);
    expect(html).toContain('Drowned Thrall');
    expect(html).toContain('HP 5/12');
  });

  it('conceals the scene in darkness (no light source)', () => {
    const html = renderViewport(DungeonSchema.parse({ player: { location: 'R01' } }));
    expect(html).toContain('You stand in darkness.');
  });

  it('does NOT throw on a malformed mob (undefined name, array status) — a render crash here froze the live panel', () => {
    // Real stored state that failed schema validation but was kept as-is; bypass the schema.
    const d = {
      player: { location: 'R01', hp: { cur: 6, max: 6 }, skills: {}, conditions: [] },
      rooms: { R01: { id: 'R01', name: 'Hall', depth: 1, exits: {}, contents: [] } },
      inventory: [],
      meta: { turn: 1, depth: 1 },
      combat: { active: true, mobs: [{ id: 'goblin_1', type: 'goblin', hp_cur: 5, hp_max: 8, status: [] }] },
    } as any;
    expect(() => renderViewport(d)).not.toThrow();
    expect(renderViewport(d)).toContain('goblin'); // name falls back to the type
  });
});
