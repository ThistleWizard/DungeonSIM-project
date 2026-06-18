/**
 * sheet.test.ts — player-facing character-sheet + inventory renderers (M8 prep). Pure
 * functions; assert the structured Gold Box HTML carries the deterministic state's fields.
 */
import { describe, expect, it } from 'vitest';
import { renderInventory, renderSheet } from '../src/sheet.js';
import { DungeonSchema } from '../src/schema.js';

function character() {
  return DungeonSchema.parse({
    light: { source: 'torch', ticks_remaining: 7 },
    player: {
      name: 'Bramble',
      class: 'Cleric',
      level: 3,
      hp: { cur: 14, max: 22 },
      defense: 13,
      stats: { str: 12, dex: 9, con: 15, int: 11, wis: 16, cha: 8 },
      skills: { arcana: { rank: 2, marks: 1, marks_needed: 7 }, stealth: { rank: 0, marks: 2, marks_needed: 3 } },
      conditions: [
        { name: 'blessed', ticks: 4 },
        { name: 'cursed', ticks: null },
      ],
    },
    inventory: [
      { id: 'mace', name: 'Iron Mace', equipped: true, notes: 'chipped' },
      { id: 'torch', name: 'Torch', qty: 3 },
      { id: 'wand', name: 'Wand of Sparks', charges: 5 },
      { id: 'robe', name: 'Healer Robe', worn: true },
    ],
  });
}

describe('renderSheet (M8 prep)', () => {
  const html = renderSheet(character());

  it('shows identity, vitals, light and defense', () => {
    expect(html).toContain('Bramble');
    expect(html).toContain('Cleric');
    expect(html).toContain('Level 3');
    expect(html).toContain('14 / 22'); // HP
    expect(html).toContain('13'); // defense
    expect(html).toContain('torch (7)'); // light source + ticks
  });

  it('renders all six ability scores', () => {
    for (const [label, val] of [
      ['STR', '12'],
      ['DEX', '9'],
      ['CON', '15'],
      ['INT', '11'],
      ['WIS', '16'],
      ['CHA', '8'],
    ]) {
      expect(html).toContain(label);
      expect(html).toContain(val);
    }
  });

  it('renders skills with rank dots and marks toward the next rank', () => {
    expect(html).toContain('arcana');
    expect(html).toContain('●●○○○'); // rank 2 of 5
    expect(html).toContain('1/7'); // marks / needed
    expect(html).toContain('stealth');
    expect(html).toContain('○○○○○'); // rank 0
  });

  it('renders conditions, with until-cured shown as ∞', () => {
    expect(html).toContain('blessed');
    expect(html).toContain('cursed');
    expect(html).toContain('∞'); // cursed has null ticks
  });

  it('escapes player-supplied text', () => {
    const evil = DungeonSchema.parse({ player: { name: '<script>x</script>' } });
    expect(renderSheet(evil)).not.toContain('<script>x');
    expect(renderSheet(evil)).toContain('&lt;script&gt;');
  });
});

describe('renderInventory (M8 prep)', () => {
  const html = renderInventory(character());

  it('lists items with quantity, flags and notes', () => {
    expect(html).toContain('Iron Mace');
    expect(html).toContain('equipped');
    expect(html).toContain('chipped'); // note
    expect(html).toContain('Torch');
    expect(html).toContain('×3'); // qty
    expect(html).toContain('5 charges');
    expect(html).toContain('worn'); // Healer Robe
  });

  it('shows an empty state when carrying nothing', () => {
    const empty = DungeonSchema.parse({});
    expect(renderInventory(empty)).toContain('carrying nothing');
  });
});
