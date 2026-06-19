/**
 * map.test.ts — M6 automap renderer. Pure-function tests (no SillyTavern), to the
 * rigor of the M1–M5 suites. Geometry is asserted through `computeLayout` (the exported
 * layout seam); the knowledge-leak and styling guards grep the rendered SVG string.
 */
import { describe, expect, it } from 'vitest';
import { computeLayout, renderMap } from '../src/map.js';
import { RoomSchema, type Room } from '../src/schema.js';

// Build a fully-defaulted Room (exit/category/lock defaults applied) from a terse spec.
function room(
  id: string,
  name: string,
  depth: number,
  exits: Record<string, Partial<Room['exits'][string]> & { to: string; type: Room['exits'][string]['type'] }>,
): Room {
  return RoomSchema.parse({ id, name, depth, exits });
}

function rooms(...rs: Room[]): Record<string, Room> {
  return Object.fromEntries(rs.map(r => [r.id, r]));
}

/** A grid-coherent 7-room loop on depth 1 (closes cleanly, no nudge needed). */
function loop7(): Record<string, Room> {
  return rooms(
    room('R01', 'Entry Hall', 1, { east: { to: 'R02', type: 'open' } }),
    room('R02', 'Corridor', 1, { east: { to: 'R03', type: 'open' }, west: { to: 'R01', type: 'open' } }),
    room('R03', 'Junction', 1, {
      south: { to: 'R04', type: 'door' },
      north: { to: 'R07', type: 'archway' },
      west: { to: 'R02', type: 'open' },
    }),
    room('R04', 'Cell Block', 1, { west: { to: 'R05', type: 'open' }, north: { to: 'R03', type: 'door' } }),
    room('R05', 'Cistern', 1, { west: { to: 'R06', type: 'open' }, east: { to: 'R04', type: 'open' } }),
    room('R06', 'Crypt', 1, { north: { to: 'R01', type: 'open' }, east: { to: 'R05', type: 'open' } }),
    room('R07', 'Shrine', 1, { south: { to: 'R03', type: 'archway' } }),
  );
}

function distinctCells(layout: Record<string, [number, number]>): boolean {
  const seen = new Set(Object.values(layout).map(c => `${c[0]},${c[1]}`));
  return seen.size === Object.keys(layout).length;
}

describe('renderMap layout (M6 §B2)', () => {
  it('places a grid-coherent 7-room loop with zero collisions', () => {
    const layout = computeLayout(loop7(), 1);
    expect(Object.keys(layout).length).toBe(7);
    expect(distinctCells(layout)).toBe(true);
  });

  it('is deterministic — same input renders byte-identical SVG', () => {
    const d = loop7();
    expect(renderMap(d, 'R03', 1)).toBe(renderMap(d, 'R03', 1));
  });

  it('is stable under growth — adding a room never moves existing rooms', () => {
    const before = computeLayout(loop7(), 1);
    const grown = loop7();
    // Hang a brand-new room off R07 (a free cell).
    grown.R07.exits.north = RoomSchema.parse({
      id: 'R07',
      name: 'x',
      exits: { north: { to: 'R08', type: 'door' } },
    }).exits.north;
    grown.R08 = room('R08', 'Reliquary', 1, { south: { to: 'R07', type: 'door' } });
    const after = computeLayout(grown, 1);
    for (const id of Object.keys(before)) {
      expect(after[id]).toEqual(before[id]);
    }
    expect(after.R08).toBeDefined();
    expect(distinctCells(after)).toBe(true);
  });

  it('places stubs in the exit true compass direction', () => {
    // R01 with two UNDISCOVERED exits (target rooms absent).
    const d = rooms(
      room('R01', 'Lone', 1, {
        west: { to: 'R99', type: 'door' },
        northeast: { to: 'R98', type: 'door' },
      }),
    );
    expect(computeLayout(d, 1).R01).toEqual([0, 0]);
    const svg = renderMap(d, 'R01', 1);
    expect(svg).toContain('<title>west</title>');
    expect(svg).toContain('<title>northeast</title>');

    // Pull each stub's `?` end-box position; with one room the centre is the canvas mid.
    const stubPts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>\?<\/text>/g)].map(m => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(stubPts.length).toBe(2);
    const cx = 44 + 104 / 2; // single-room centre = default pad + cell/2
    const west = stubPts.find(p => p[0] < cx)!; // west reaches left of centre
    const ne = stubPts.find(p => p[0] > cx)!; // NE reaches right of centre
    expect(west).toBeDefined();
    expect(Math.abs(west[1] - cx)).toBeLessThan(6); // west is horizontal (≈centre y, +text baseline)
    expect(ne).toBeDefined();
    expect(ne[1]).toBeLessThan(cx - 20); // NE clearly goes UP (smaller y)
  });

  it('fires the collision nudge on a non-Euclidean 4-room loop without overlap', () => {
    // N, E, S, W that do NOT close: R01-N->R02-E->R03-S->R04-W->R01 lands R04 back on R01.
    const d = rooms(
      room('R01', 'A', 1, { north: { to: 'R02', type: 'open' } }),
      room('R02', 'B', 1, { east: { to: 'R03', type: 'open' } }),
      room('R03', 'C', 1, { south: { to: 'R04', type: 'open' } }),
      room('R04', 'D', 1, { west: { to: 'R01', type: 'open' } }),
    );
    const layout = computeLayout(d, 1);
    expect(Object.keys(layout).length).toBe(4);
    expect(distinctCells(layout)).toBe(true); // nudge fired, no overlap
    expect(() => renderMap(d, 'R01', 1)).not.toThrow();
  });
});

describe('renderMap unexplored exits (to: null)', () => {
  it('renders an unexplored exit (to: null) as a stub, never an edge, without throwing', () => {
    const d = rooms(room('R01', 'Entry', 1, { south: { to: null as unknown as string, type: 'open' } }));
    expect(() => renderMap(d, 'R01', 1)).not.toThrow();
    const svg = renderMap(d, 'R01', 1);
    expect(svg).toContain('>?<'); // a generic undiscovered stub
    expect(computeLayout(d, 1)).toEqual({ R01: [0, 0] }); // the null exit doesn't place a phantom room
  });
});

describe('renderMap depth filtering (M6 §B1)', () => {
  it('omits rooms on other depths but keeps a vertical exit as a marker', () => {
    const d = rooms(
      room('R01', 'Top', 1, { down: { to: 'R02', type: 'stairs_down', category: 'vertical' } }),
      room('R02', 'Below', 2, { up: { to: 'R01', type: 'stairs_up', category: 'vertical' } }),
    );
    const layout1 = computeLayout(d, 1);
    expect(Object.keys(layout1)).toEqual(['R01']); // R02 (depth 2) absent
    const svg = renderMap(d, 'R01', 1);
    expect(svg).not.toContain('Below'); // off-level room name does not appear
    expect(svg).toContain('↓'); // vertical marker rendered
    expect(svg).toContain('(to depth 2)'); // traversed → destination depth known
  });
});

describe('renderMap current-room highlight (M6 §B4)', () => {
  it('marks only the current room with the amber @ YOU tag', () => {
    const svg = renderMap(loop7(), 'R03', 1);
    expect(svg).toContain('@ YOU');
    expect(svg).toContain('#e8c468'); // amber highlight present
    // Exactly one YOU tag.
    expect(svg.match(/@ YOU/g)?.length).toBe(1);
  });

  it('renders no YOU tag when the current room is off-level / unknown', () => {
    const svg = renderMap(loop7(), 'R99', 1);
    expect(svg).not.toContain('@ YOU');
  });
});

describe('renderMap knowledge model (M6 §B6 — do not leak)', () => {
  it('shows NO lock styling for an unrevealed lock', () => {
    const d = rooms(
      room('R01', 'A', 1, { east: { to: 'R02', type: 'door', lock: 'barred', lock_revealed: false } }),
      room('R02', 'B', 1, { west: { to: 'R01', type: 'door' } }),
    );
    const svg = renderMap(d, 'R01', 1);
    expect(svg).not.toContain('#a06a2c'); // no amber lock-edge colour
    expect(svg).not.toContain('stroke-dasharray="6 5"'); // no lock dash
  });

  it('renders an untraversed portal as a generic stub — no glyph, no category hint', () => {
    // category:'portal' but the target room does not exist → undiscovered.
    const d = rooms(room('R01', 'A', 1, { enter: { to: 'R77', type: 'archway', category: 'portal' } }));
    const svg = renderMap(d, 'R01', 1);
    expect(svg).not.toContain('⊙'); // no portal glyph
    expect(svg).not.toContain('portal'); // category never named in output
    expect(svg).not.toContain('archway'); // fiction type not leaked on an undiscovered stub
    expect(svg).toContain('>?<'); // a generic ? stub box is present
  });

  it('DOES show lock styling once the lock is revealed (positive control)', () => {
    const d = rooms(
      room('R01', 'A', 1, { east: { to: 'R02', type: 'door', lock: 'barred', lock_revealed: true } }),
      room('R02', 'B', 1, { west: { to: 'R01', type: 'door' } }),
    );
    const svg = renderMap(d, 'R01', 1);
    expect(svg).toContain('#a06a2c');
    expect(svg).toContain('stroke-dasharray="6 5"');
  });

  it('renders a traversed portal as a portal marker (positive control)', () => {
    const d = rooms(
      room('R01', 'A', 1, { enter: { to: 'R09', type: 'archway', category: 'portal' } }),
      room('R09', 'Elsewhere', 1, {}),
    );
    const svg = renderMap(d, 'R01', 1);
    expect(svg).toContain('⊙');
  });
});

describe('renderMap cartographer model (visible fiction, hidden wiring)', () => {
  it('shows visible-but-undescended stairs as a ↓ marker, without revealing the destination', () => {
    // Player stands in R01, sees stairs down; has not descended (target room absent).
    const d = rooms(room('R01', 'Landing', 1, { down: { to: 'R02', type: 'stairs_down', category: 'vertical' } }));
    const svg = renderMap(d, 'R01', 1);
    expect(svg).toContain('↓'); // the staircase you can see is drawn
    expect(svg).not.toContain('to depth'); // but where it leads is unknown until used
  });

  it('reveals the destination depth once the stairs are descended', () => {
    const d = rooms(
      room('R01', 'Landing', 1, { down: { to: 'R02', type: 'stairs_down', category: 'vertical' } }),
      room('R02', 'Sump', 2, { up: { to: 'R01', type: 'stairs_up', category: 'vertical' } }),
    );
    const svg = renderMap(d, 'R01', 1);
    expect(svg).toContain('↓');
    expect(svg).toContain('(to depth 2)');
  });

  it('renders NOTHING for a secret (state:hidden) exit — no stub, no marker', () => {
    const d = rooms(
      room('R01', 'Vault', 1, {
        north: { to: 'R02', type: 'secret', state: 'hidden' }, // undiscovered secret passage
        east: { to: 'R03', type: 'door' }, // ordinary visible way out (control)
      }),
    );
    const svg = renderMap(d, 'R01', 1);
    // The secret produces no stub box; only the visible east door does.
    expect((svg.match(/>\?</g) ?? []).length).toBe(1);
    expect(svg).toContain('<title>east</title>');
    expect(svg).not.toContain('<title>north</title>');
  });

  it('keeps a disguised portal (non-vertical fiction) as a plain stub until traversed', () => {
    // type:'archway' but category:'portal' (a hidden teleport). Untraversed → no glyph leak.
    const d = rooms(room('R01', 'A', 1, { east: { to: 'R88', type: 'archway', category: 'portal' } }));
    const svg = renderMap(d, 'R01', 1);
    expect(svg).not.toContain('⊙');
    expect(svg).not.toContain('↓');
    expect(svg).not.toContain('portal');
    expect(svg).toContain('>?<'); // just an ordinary unexplored exit
  });
});

describe('renderMap structure', () => {
  it('emits a responsive viewBox SVG with a depth badge and data-room-id hooks', () => {
    const svg = renderMap(loop7(), 'R01', 1);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('viewBox="0 0');
    expect(svg).toContain('width="100%"');
    expect(svg).toContain('DEPTH 1');
    expect(svg).toContain('data-room-id="R01"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('renders a placeholder for an empty level', () => {
    const svg = renderMap({}, undefined, 3);
    expect(svg).toContain('DEPTH 3');
    expect(svg).toContain('no mapped rooms on this level');
  });
});
