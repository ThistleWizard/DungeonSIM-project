import { describe, expect, it } from 'vitest';
import { DungeonSchema, type Dungeon } from '../src/schema.js';
import { embedFooter, renderFooter, stripFooter, FOOTER_OPEN } from '../src/footer.js';

const dungeon = (over: Record<string, any>): Dungeon =>
  DungeonSchema.parse({
    player: { hp: { cur: 9, max: 9 }, location: 'R04' },
    rooms: {
      R04: {
        id: 'R04',
        name: 'Flooded Passage',
        exits: { south: { to: 'R03', type: 'open' }, north: { to: null, type: 'open' } },
        contents: [],
      },
    },
    ...over,
  });

describe('renderFooter', () => {
  it('renders Light/Exits/Here from applied state when lit', () => {
    const d = dungeon({ light: { source: 'Torch', ticks_remaining: 54 } });
    expect(renderFooter(d)).toBe(
      ['Light: Torch (54 left)', 'Exits: south (open), north (open)', 'Here: nothing of note.'].join('\n'),
    );
  });

  it('notes non-open exit state and prettifies underscored types', () => {
    const d = dungeon({
      light: { source: 'Lantern', ticks_remaining: 100 },
      rooms: {
        R04: {
          id: 'R04',
          name: 'Vault',
          exits: {
            north: { to: null, type: 'door', state: 'locked' },
            down: { to: null, type: 'stairs_down' },
          },
          contents: [],
        },
      },
    });
    expect(renderFooter(d)).toContain('Exits: north (door, locked), down (stairs down)');
  });

  it('lists lit contents with quantities', () => {
    const d = dungeon({
      light: { source: 'Torch', ticks_remaining: 12 },
      rooms: {
        R04: {
          id: 'R04',
          name: 'Larder',
          exits: { south: { to: 'R03', type: 'open' } },
          contents: [{ id: 'rat_corpse', name: 'giant rat corpse', kind: 'corpse' }, { id: 'coin', name: 'coin', qty: 7 }],
        },
      },
    });
    expect(renderFooter(d)).toContain('Here: giant rat corpse, coin x7');
  });

  it('conceals contents and reports darkness when no light is active', () => {
    const d = dungeon({ light: null });
    const out = renderFooter(d);
    expect(out).toContain('Light: none - you stand in darkness');
    expect(out).toContain("Here: you can't see - no light.");
    // Exits are still felt-for in the dark.
    expect(out).toContain('Exits: south (open), north (open)');
  });

  it('returns empty string before a room exists (chargen/seed state)', () => {
    expect(renderFooter(DungeonSchema.parse({}))).toBe('');
  });
});

describe('embedFooter', () => {
  const footer = 'Light: Torch (54 left)\nExits: south (open)\nHere: nothing of note.';

  it('inserts the footer immediately before the <UpdateDungeon> block', () => {
    const msg = "The rat dies.\n<UpdateDungeon>\n_.add('player.hp.cur', -2);//bite\n</UpdateDungeon>";
    const out = embedFooter(msg, footer);
    expect(out.indexOf(FOOTER_OPEN)).toBeGreaterThan(out.indexOf('The rat dies.'));
    expect(out.indexOf(FOOTER_OPEN)).toBeLessThan(out.indexOf('<UpdateDungeon>'));
    expect(out).toContain(footer);
  });

  it('appends to the end when there is no mutation block', () => {
    const out = embedFooter('Just narration.', footer);
    expect(out.startsWith('Just narration.')).toBe(true);
    expect(out).toContain(footer);
  });

  it('is idempotent — re-embedding replaces the prior footer, never stacks', () => {
    const msg = "Narration.\n<UpdateDungeon>\n_.add('meta.turn', 1);//tick\n</UpdateDungeon>";
    const once = embedFooter(msg, footer);
    const twice = embedFooter(once, 'Light: Torch (53 left)\nExits: south (open)\nHere: nothing of note.');
    expect((twice.match(/ds-footer/g) ?? []).length).toBe(2); // exactly one open + one close
    expect(twice).toContain('53 left');
    expect(twice).not.toContain('54 left');
  });

  it('stripFooter removes an embedded block cleanly', () => {
    const msg = 'Narration.';
    const embedded = embedFooter(msg, footer);
    expect(stripFooter(embedded)).toBe('Narration.');
  });
});
