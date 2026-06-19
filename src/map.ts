/**
 * map.ts — the automap renderer (milestone M6). A PURE function: no SillyTavern,
 * no globals, fully unit-testable. Turns the canonical `dungeon.rooms` graph into a
 * clean 8-bit SVG automap of the CURRENT depth. See DungeonState-M6-spec.md.
 *
 * Three hard rules drive the design:
 *  - Grid-walk layout (§spec B2): deterministic + STABLE — same input → byte-identical
 *    coordinates; adding a room never moves an existing one.
 *  - Three-layer knowledge model (§spec B6): draw ONLY what the player has discovered.
 *    Undiscovered exits leak nothing about category (spatial/vertical/portal) or lock.
 *  - Current-depth only (§spec B1): rooms are filtered by `room.depth`; vertical/portal
 *    links render as MARKERS, never positioned edges, and never pull off-level rooms in.
 */
import type { Exit, Room } from './schema.js';

// ---------- tunable style constants (§spec B3) ----------

export interface MapRenderOptions {
  cell?: number; // grid spacing between room centres (px)
  box?: number; // room box edge (px)
  pad?: number; // outer margin — also the room for stubs/markers (px)
  stub?: number; // length of an undiscovered-exit stub (px)
  // palette
  bg?: string;
  grid?: string;
  boxFill?: string;
  boxStroke?: string;
  edge?: string;
  lockEdge?: string; // a revealed, obstructed link
  highlight?: string; // current-room amber
  text?: string;
  textDim?: string;
  // typography
  fontId?: number;
  fontName?: number;
  fontBadge?: number;
}

interface Style extends Required<MapRenderOptions> {}

const DEFAULTS: Style = {
  cell: 104,
  box: 76,
  pad: 44,
  stub: 22,
  bg: '#0a0a18',
  grid: '#1b1733',
  boxFill: '#141026',
  boxStroke: '#c8a84a',
  edge: '#5a7ab8',
  lockEdge: '#a06a2c',
  highlight: '#f0d878',
  text: '#d8c8a0',
  textDim: '#7a6a4a',
  fontId: 13,
  fontName: 11,
  fontBadge: 12,
};

// ---------- grid geometry ----------

/** Unit step in cell-space for each compass direction (§spec B2). y grows downward. */
const DIR_VEC: Record<string, readonly [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [1, -1],
  northwest: [-1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
};

/** Fixed iteration order for exits → deterministic BFS + stub placement. */
const DIR_ORDER = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'] as const;

type Cell = readonly [number, number];
const cellKey = (c: Cell): string => `${c[0]},${c[1]}`;

/** Exit fictions the player visibly reads as vertical (stairs/ladder/hole) — safe to show
 * before traversal because they reveal what's SEEN, not the hidden wiring. A trapdoor
 * disguised as an archway has a non-vertical `type`, so it stays a plain stub until used. */
const VERTICAL_FICTION = new Set(['stairs_up', 'stairs_down', 'ladder', 'hole']);
const isVerticalFiction = (type: string): boolean => VERTICAL_FICTION.has(type);

/**
 * Spiral outward from a target cell to the nearest free cell (collision nudge, §spec B2).
 * Deterministic ring-by-ring scan so the same occupancy always yields the same nudge.
 */
function nearestFree(target: Cell, occupied: Set<string>): Cell {
  if (!occupied.has(cellKey(target))) return target;
  for (let r = 1; r < 64; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring edge only
        const c: Cell = [target[0] + dx, target[1] + dy];
        if (!occupied.has(cellKey(c))) return c;
      }
    }
  }
  return target; // pathological; never reached for sane maps
}

/**
 * Grid-walk all on-level rooms into cells. Stable root (R01 if present, else lowest id),
 * deterministic BFS in DIR_ORDER, only ever assigning a cell to a not-yet-placed room.
 * Disconnected components are seeded from their lowest-id room at the next free cell.
 */
function layout(levelRooms: Room[]): Map<string, Cell> {
  const placed = new Map<string, Cell>();
  const occupied = new Set<string>();
  const byId = new Map(levelRooms.map(r => [r.id, r]));
  const ids = levelRooms.map(r => r.id).sort();

  const assign = (id: string, c: Cell): void => {
    placed.set(id, c);
    occupied.add(cellKey(c));
  };

  const place = (rootId: string): void => {
    const queue: string[] = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const cell = placed.get(id)!;
      const room = byId.get(id)!;
      for (const dir of DIR_ORDER) {
        const exit = room.exits[dir];
        if (!exit || exit.category !== 'spatial' || exit.to == null) continue;
        const target = byId.get(exit.to);
        if (!target || placed.has(target.id)) continue; // off-level / stub / already placed
        const want: Cell = [cell[0] + DIR_VEC[dir][0], cell[1] + DIR_VEC[dir][1]];
        assign(target.id, nearestFree(want, occupied));
        queue.push(target.id);
      }
    }
  };

  // Stable root for the primary component.
  const root = byId.has('R01') ? 'R01' : ids[0];
  if (root !== undefined) {
    assign(root, [0, 0]);
    place(root);
  }
  // Any unreached component: seed its lowest-id room at the next free cell to the right.
  for (const id of ids) {
    if (placed.has(id)) continue;
    let x = 0;
    while (occupied.has(cellKey([x, 0]))) x++;
    assign(id, [x, 0]);
    place(id);
  }
  return placed;
}

/**
 * Public layout seam (for tests + future panels): the deterministic cell coordinates
 * the renderer assigns to each on-level room. Same filtering/sorting as `renderMap`, so
 * what you read here is exactly what gets drawn. Returns `{ R01: [x, y], ... }`.
 */
export function computeLayout(rooms: Record<string, Room>, depth: number): Record<string, [number, number]> {
  const levelRooms = Object.values(rooms ?? {})
    .filter(r => r.depth === depth)
    .sort((a, b) => a.id.localeCompare(b.id));
  const placed = layout(levelRooms);
  const out: Record<string, [number, number]> = {};
  for (const [id, c] of placed) out[id] = [c[0], c[1]];
  return out;
}

// ---------- SVG helpers ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Greedy word-wrap to at most `maxLines` lines of `maxChars`; null if it doesn't fit. */
function wrap(text: string, maxChars: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (w.length > maxChars) return null; // a single word overflows the box
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) return null;
    }
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

/** Player-known hover text for a room: name + (only if visited) a terse contents line. */
function roomTitle(room: Room, isCurrent: boolean): string {
  const parts = [`${room.id} — ${room.name}`];
  if (isCurrent) parts.push('(you are here)');
  if (room.visited && room.contents.length > 0) {
    parts.push('Here: ' + room.contents.map(c => (c.qty > 1 ? `${c.name} ×${c.qty}` : c.name)).join(', '));
  }
  return esc(parts.join('  '));
}

// ---------- the renderer ----------

export function renderMap(
  rooms: Record<string, Room>,
  currentRoomId: string | undefined,
  depth: number,
  opts: MapRenderOptions = {},
): string {
  const s: Style = { ...DEFAULTS, ...opts };
  const all = Object.values(rooms ?? {});
  const levelRooms = all.filter(r => r.depth === depth).sort((a, b) => a.id.localeCompare(b.id));

  const placed = layout(levelRooms);

  // Bounding box in cell-space (default to a 1×1 canvas when the level is empty).
  let minX = 0,
    minY = 0,
    maxX = 0,
    maxY = 0;
  let first = true;
  for (const c of placed.values()) {
    if (first) {
      minX = maxX = c[0];
      minY = maxY = c[1];
      first = false;
    } else {
      minX = Math.min(minX, c[0]);
      minY = Math.min(minY, c[1]);
      maxX = Math.max(maxX, c[0]);
      maxY = Math.max(maxY, c[1]);
    }
  }
  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const W = cols * s.cell + s.pad * 2;
  const H = rows * s.cell + s.pad * 2;

  const cx = (cell: Cell): number => s.pad + (cell[0] - minX) * s.cell + s.cell / 2;
  const cy = (cell: Cell): number => s.pad + (cell[1] - minY) * s.cell + s.cell / 2;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" ` +
      `preserveAspectRatio="xMidYMid meet" font-family="monospace" ` +
      `style="max-width:${W}px;background:${s.bg}" data-depth="${depth}">`,
  );
  // dotted grid texture
  out.push(
    `<defs><pattern id="dg" width="${s.cell / 2}" height="${s.cell / 2}" patternUnits="userSpaceOnUse">` +
      `<circle cx="1" cy="1" r="1" fill="${s.grid}"/></pattern></defs>`,
  );
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${s.bg}"/>`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#dg)"/>`);

  // ---- edges first (under the boxes) ----
  const drawnPairs = new Set<string>();
  for (const room of levelRooms) {
    const from = placed.get(room.id);
    if (!from) continue;
    for (const dir of DIR_ORDER) {
      const exit = room.exits[dir];
      if (!exit || exit.category !== 'spatial' || exit.to == null) continue;
      if (exit.state === 'hidden') continue; // secret/unfound → perceive nothing (§spec B6)
      const to = placed.get(exit.to);
      if (!to) continue; // stub / off-level (handled below)
      const pairKey = [room.id, exit.to].sort().join('|');
      if (drawnPairs.has(pairKey)) continue;
      drawnPairs.add(pairKey);
      const revealedLock = exit.lock_revealed && exit.lock !== 'none';
      const stroke = revealedLock ? s.lockEdge : s.edge;
      const dash = revealedLock ? ' stroke-dasharray="6 5"' : '';
      out.push(
        `<line x1="${cx(from)}" y1="${cy(from)}" x2="${cx(to)}" y2="${cy(to)}" ` +
          `stroke="${stroke}" stroke-width="2"${dash}/>`,
      );
    }
  }

  // ---- non-spatial markers + unexplored stubs (per room) ----
  // Cartographer model: draw what the player can SEE (the exit's fiction = `type`); hide
  // the WIRING (`category`) and DESTINATION until the link is traversed. Secret exits show
  // nothing. So visible stairs always render as ↓; an archway that's *secretly* a portal/
  // trapdoor renders as a plain unexplored stub until used — no leak (§spec B6).
  for (const room of levelRooms) {
    const cell = placed.get(room.id);
    if (!cell) continue;
    const x = cx(cell),
      y = cy(cell);
    const half = s.box / 2;
    for (const [dir, exit] of Object.entries(room.exits)) {
      if (exit.state === 'hidden') continue; // secret/unfound → perceive nothing
      const traversed = exit.to != null && rooms[exit.to] !== undefined; // target room exists = link used

      if (traversed) {
        // Wiring is now known — render by category, with the destination on hover.
        if (exit.category === 'spatial') continue; // already drawn as an edge (or off-level)
        out.push(
          exit.category === 'vertical'
            ? verticalMarker(x + half - 9, y - half + 9, exit, rooms, s)
            : portalMarker(x - half + 9, y - half + 9, exit, s),
        );
        continue;
      }

      // Untraversed but perceived → render by FICTION only. Visible vertical fiction
      // (stairs/ladder/hole) shows its ↓/↑ marker WITHOUT a destination; everything else
      // (doors, archways, and any link whose true category is still concealed) is a stub.
      if (isVerticalFiction(exit.type)) {
        out.push(verticalMarker(x + half - 9, y - half + 9, exit, rooms, s));
      } else {
        out.push(stub(x, y, half, dir, s));
      }
    }
  }

  // ---- room boxes on top ----
  for (const room of levelRooms) {
    const cell = placed.get(room.id);
    if (!cell) continue;
    out.push(roomBox(room, cx(cell), cy(cell), room.id === currentRoomId, s));
  }

  // ---- depth badge (corner) ----
  out.push(
    `<rect x="8" y="8" width="${10 + 9 * `DEPTH ${depth}`.length}" height="22" rx="3" ` +
      `fill="#141026" stroke="${s.boxStroke}"/>` +
      `<text x="14" y="23" fill="${s.highlight}" font-size="${s.fontBadge}" font-weight="bold">DEPTH ${depth}</text>`,
  );

  if (levelRooms.length === 0) {
    out.push(
      `<text x="${W / 2}" y="${H / 2}" fill="${s.textDim}" font-size="13" ` +
        `text-anchor="middle">no mapped rooms on this level</text>`,
    );
  }

  out.push('</svg>');
  return out.join('');
}

// ---------- per-element builders ----------

function roomBox(room: Room, x: number, y: number, isCurrent: boolean, s: Style): string {
  const half = s.box / 2;
  const left = x - half,
    top = y - half;
  const stroke = isCurrent ? s.highlight : s.boxStroke;
  const parts: string[] = [];
  parts.push(`<g data-room-id="${esc(room.id)}"><title>${roomTitle(room, isCurrent)}</title>`);
  parts.push(
    `<rect x="${left}" y="${top}" width="${s.box}" height="${s.box}" rx="4" ` +
      `fill="${s.boxFill}" stroke="${stroke}" stroke-width="${isCurrent ? 2.5 : 1.5}"/>`,
  );
  if (isCurrent) {
    // inner outline + @ YOU tag
    parts.push(
      `<rect x="${left + 4}" y="${top + 4}" width="${s.box - 8}" height="${s.box - 8}" rx="3" ` +
        `fill="none" stroke="${s.highlight}" stroke-width="1" opacity="0.55"/>`,
    );
  }
  // id (always)
  parts.push(
    `<text x="${x}" y="${top + 16}" fill="${isCurrent ? s.highlight : s.text}" ` +
      `font-size="${s.fontId}" font-weight="bold" text-anchor="middle">${esc(room.id)}</text>`,
  );
  // name, wrapped to ≤2 lines if it fits; else id-only
  const maxChars = Math.floor((s.box - 10) / (s.fontName * 0.62));
  const lines = wrap(room.name, maxChars, 2);
  if (lines) {
    lines.forEach((ln, i) => {
      parts.push(
        `<text x="${x}" y="${y + 6 + i * (s.fontName + 2)}" fill="${s.textDim}" ` +
          `font-size="${s.fontName}" text-anchor="middle">${esc(ln)}</text>`,
      );
    });
  }
  if (isCurrent) {
    parts.push(
      `<text x="${x}" y="${top + s.box - 7}" fill="${s.highlight}" font-size="${s.fontName}" ` +
        `font-weight="bold" text-anchor="middle">@ YOU</text>`,
    );
  }
  parts.push('</g>');
  return parts.join('');
}

function verticalMarker(x: number, y: number, exit: Exit, rooms: Record<string, Room>, s: Style): string {
  const up = /up/.test(exit.type);
  const glyph = up ? '↑' : '↓';
  const dest = exit.to != null ? rooms[exit.to] : undefined;
  const label = exit.type.replace(/_/g, ' ') + (dest ? ` (to depth ${dest.depth})` : '');
  return (
    `<g><title>${esc(label)}</title>` +
    `<circle cx="${x}" cy="${y}" r="9" fill="#141026" stroke="${s.edge}"/>` +
    `<text x="${x}" y="${y + 4}" fill="${s.edge}" font-size="12" text-anchor="middle">${glyph}</text></g>`
  );
}

function portalMarker(x: number, y: number, exit: Exit, s: Style): string {
  return (
    `<g><title>${esc(exit.type.replace(/_/g, ' '))}</title>` +
    `<circle cx="${x}" cy="${y}" r="9" fill="#141026" stroke="${s.highlight}"/>` +
    `<text x="${x}" y="${y + 4}" fill="${s.highlight}" font-size="12" text-anchor="middle">⊙</text></g>`
  );
}

function stub(x: number, y: number, half: number, dir: string, s: Style): string {
  // Direction vector if the key is a compass direction; else a neutral downward nub so a
  // non-compass undiscovered way out ('down'/'enter') still shows WITHOUT hinting category.
  const v = DIR_VEC[dir] ?? [0, 1];
  const len = Math.hypot(v[0], v[1]) || 1;
  const ux = v[0] / len,
    uy = v[1] / len;
  const x1 = x + ux * half,
    y1 = y + uy * half;
  const x2 = x + ux * (half + s.stub),
    y2 = y + uy * (half + s.stub);
  return (
    `<g><title>${esc(DIR_VEC[dir] ? dir : 'unexplored way')}</title>` +
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${s.textDim}" ` +
    `stroke-width="2" stroke-dasharray="3 3"/>` +
    `<rect x="${x2 - 6}" y="${y2 - 6}" width="12" height="12" rx="2" fill="#141026" stroke="${s.textDim}"/>` +
    `<text x="${x2}" y="${y2 + 4}" fill="${s.textDim}" font-size="10" text-anchor="middle">?</text></g>`
  );
}
