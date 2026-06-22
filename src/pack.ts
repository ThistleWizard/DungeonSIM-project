/**
 * pack.ts — the sprite PACK: format + the bundled default pack (M7, design §15).
 *
 * A pack is CONTENT, not engine (like the preset / §13 cartridges): a manifest of
 * `{ id, tags, src }` sprites that the pure resolver (`src/sprites.ts`) scores the model's
 * bestiary tags against. Pack-agnostic — a different pack is a different module with the same
 * shape; the resolver doesn't care where `src` points (data-URI or URL). 8-bit sprites are
 * tiny, so the default pack inlines them as SVG data-URIs → fully self-contained, no asset
 * hosting, no licensing risk (these silhouettes are authored here).
 *
 * The default pack ships category-generic silhouettes (one+ per archetype, a few with refined
 * descriptor tags so per-instance variety is observable). A real CC0 raster pack (DawnLike /
 * Oryx / Kenney-class) drops in later as pure content: same manifest, different `src`s.
 *
 * The CONTROLLED VOCAB the model emits (taught by the preset, never the catalog) lives here too
 * (`ARCHETYPES` / `SIZES` / `DESCRIPTORS`) so the vocab and the art that keys off it stay in one
 * place. Archetype tags are the primary axis (weighted high in the resolver); the FIRST tag a
 * mob carries is its primary archetype by convention.
 */

export interface SpriteEntry {
  /** Stable pack-unique id, e.g. "goblin_01". The resolver returns `pack:<id>`. */
  id: string;
  /** Descriptor tags for matching (same vocab the model emits). */
  tags: string[];
  /** Image source — a data-URI here, but a URL works identically. */
  src: string;
}

export interface SpritePack {
  id: string;
  name: string;
  sprites: SpriteEntry[];
  /** Archetype tag -> sprite id, the last-resort match when nothing scores. */
  categoryGenerics?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Controlled vocabulary (the model picks from these; the resolver scores them).
// ---------------------------------------------------------------------------

/** Primary axis — the creature's body plan. First tag a mob carries, by convention. */
export const ARCHETYPES = [
  'humanoid',
  'beast',
  'undead',
  'construct',
  'ooze',
  'dragon',
  'insectoid',
  'demon',
  'elemental',
  'plant',
  'vermin',
  'aberration',
  'fey',
] as const;

/** Scale axis. */
export const SIZES = ['tiny', 'small', 'medium', 'large', 'huge'] as const;

/** Refinement axis — visual descriptors (weighted lower than archetype in scoring). */
export const DESCRIPTORS = [
  'armored',
  'winged',
  'horned',
  'robed',
  'skeletal',
  'fanged',
  'tentacled',
  'fiery',
  'icy',
  'spectral',
  'aquatic',
  'clawed',
  'scaled',
  'furred',
  'multi_eyed',
] as const;

// ---------------------------------------------------------------------------
// Silhouette art — simple 32x32 SVG shapes, tinted per archetype. Authored here.
// ---------------------------------------------------------------------------

/** A distinctive silhouette body per shape key (path/markup inside a 0 0 32 32 viewBox). */
const SHAPES: Record<string, string> = {
  // upright biped: head + shouldered torso
  biped: '<circle cx="16" cy="8" r="5"/><path d="M9 30 Q9 15 16 15 Q23 15 23 30 Z"/>',
  // quadruped beast: low body + four legs + head
  quad: '<ellipse cx="15" cy="18" rx="11" ry="6"/><circle cx="26" cy="14" r="4"/><rect x="7" y="22" width="3" height="7"/><rect x="13" y="22" width="3" height="7"/><rect x="19" y="22" width="3" height="7"/><rect x="24" y="22" width="3" height="7"/>',
  // skull (undead)
  skull:
    '<path d="M16 4 Q26 4 26 16 Q26 22 22 24 L22 28 L10 28 L10 24 Q6 22 6 16 Q6 4 16 4 Z"/><circle cx="12" cy="16" r="2.5" fill="#000"/><circle cx="20" cy="16" r="2.5" fill="#000"/>',
  // blocky construct
  block: '<rect x="8" y="6" width="16" height="10" rx="1"/><rect x="6" y="18" width="20" height="10" rx="1"/>',
  // amorphous blob (ooze/vermin)
  blob: '<path d="M6 26 Q4 14 12 12 Q14 4 20 10 Q30 12 26 24 Q28 30 18 28 Q10 32 6 26 Z"/>',
  // winged (dragon/demon)
  winged:
    '<path d="M16 10 Q22 12 24 26 L8 26 Q10 12 16 10 Z"/><path d="M16 12 L2 6 L8 18 Z"/><path d="M16 12 L30 6 L24 18 Z"/>',
  // segmented insectoid
  insect:
    '<circle cx="16" cy="9" r="4"/><ellipse cx="16" cy="17" rx="5" ry="4"/><ellipse cx="16" cy="25" rx="6" ry="5"/><path d="M11 16 L4 12 M21 16 L28 12 M11 24 L4 26 M21 24 L28 26" stroke-width="1.5"/>',
  // flame/elemental swirl
  flame: '<path d="M16 4 Q22 12 18 18 Q24 16 22 26 Q16 32 10 26 Q8 16 14 18 Q10 12 16 4 Z"/>',
  // plant stalk
  plant:
    '<rect x="14" y="14" width="4" height="14"/><path d="M16 14 Q6 10 10 4 Q16 8 16 14 Q16 8 22 4 Q26 10 16 14 Z"/>',
  // single great eye (aberration)
  eye: '<ellipse cx="16" cy="16" rx="13" ry="9"/><circle cx="16" cy="16" r="5" fill="#000"/><path d="M16 7 L16 2 M16 25 L16 30 M3 16 L8 16 M24 16 L29 16" stroke-width="1.5"/>',
};

/** Build an SVG data-URI for a tinted silhouette. URL-encoded → works in any `<img src>`. */
function svg(shape: string, color: string): string {
  const inner = SHAPES[shape] ?? SHAPES.blob;
  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">` +
    `<g fill="${color}" stroke="${color}" stroke-linejoin="round">${inner}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(doc)}`;
}

// archetype -> [shape, two tints] for the body plan. TWO generics per archetype (same
// archetype-only tags, different tint) is what makes per-instance variety the COMMON case:
// any mob whose best match is its archetype ties across the pair → hashId(mob.id) picks one,
// so two same-type mobs can differ while each stays stable. categoryGenerics points at `_01`.
const ARCHETYPE_ART: Record<string, [string, string, string]> = {
  humanoid: ['biped', '#9aa0b0', '#7a8090'],
  beast: ['quad', '#a07a4a', '#8a6a3a'],
  undead: ['skull', '#c8c0a8', '#a8a088'],
  construct: ['block', '#7a7a8a', '#9a9aaa'],
  ooze: ['blob', '#5a9a4a', '#4a8a6a'],
  dragon: ['winged', '#b04a3a', '#8a3a4a'],
  insectoid: ['insect', '#6a8a3a', '#5a7a4a'],
  demon: ['winged', '#7a2a3a', '#9a2a2a'],
  elemental: ['flame', '#d88a30', '#d0b030'],
  plant: ['plant', '#4a8a4a', '#5a9a5a'],
  vermin: ['blob', '#8a6a4a', '#6a5a3a'],
  aberration: ['eye', '#7a4a8a', '#5a4a9a'],
  fey: ['biped', '#5a9a8a', '#5a8a9a'],
};

function generics(archetype: string): SpriteEntry[] {
  const [shape, c1, c2] = ARCHETYPE_ART[archetype] ?? ['blob', '#888888', '#aaaaaa'];
  return [
    { id: `${archetype}_01`, tags: [archetype], src: svg(shape, c1) },
    { id: `${archetype}_02`, tags: [archetype], src: svg(shape, c2) },
  ];
}

/**
 * Paired descriptor variants — so a descriptor tag demonstrably shifts the pick (an armored
 * humanoid beats a plain one) WHILE variety is preserved (two armored sprites tie → hash picks).
 * A richer real pack adds more; the resolver scores whatever the pack provides.
 */
const VARIANTS: SpriteEntry[] = [
  { id: 'humanoid_armored_a', tags: ['humanoid', 'armored'], src: svg('biped', '#c8a84a') },
  { id: 'humanoid_armored_b', tags: ['humanoid', 'armored'], src: svg('biped', '#b09030') },
  { id: 'humanoid_robed_a', tags: ['humanoid', 'robed'], src: svg('biped', '#6a5a9a') },
  { id: 'humanoid_robed_b', tags: ['humanoid', 'robed'], src: svg('biped', '#5a4a8a') },
  { id: 'undead_skeletal_a', tags: ['undead', 'skeletal'], src: svg('skull', '#e0dcc0') },
  { id: 'undead_skeletal_b', tags: ['undead', 'skeletal'], src: svg('skull', '#d0ccb0') },
  { id: 'dragon_scaled_a', tags: ['dragon', 'scaled', 'winged'], src: svg('winged', '#3a8a4a') },
  { id: 'dragon_scaled_b', tags: ['dragon', 'scaled', 'winged'], src: svg('winged', '#3a7a5a') },
];

/** The bundled, self-contained default pack. Swap this module to ship a different pack. */
export const DEFAULT_PACK: SpritePack = {
  id: 'builtin-silhouettes',
  name: 'Built-in Silhouettes',
  sprites: [...ARCHETYPES.flatMap(generics), ...VARIANTS],
  categoryGenerics: Object.fromEntries(ARCHETYPES.map(a => [a, `${a}_01`])),
};
