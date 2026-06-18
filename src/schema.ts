/**
 * schema.ts — DungeonState chat-scope state tree (milestone M1).
 *
 * Refined from the design handoff draft (dungeon-schema.zod.ts). See
 * DungeonState-Design.md §5 and §10.
 *
 * NOTE on `z`: Tavern Helper exposes `z` as an auto-imported global at runtime.
 * For a buildable + unit-testable project we import zod explicitly here; this
 * works identically in the ST iframe (the global just shadows an unused import)
 * and in Vitest.
 */
import { z } from 'zod';

// ---------- leaf shapes ----------

export const SkillSchema = z.object({
  rank: z.number().int().min(0).max(5).default(0),
  marks: z.number().int().min(0).default(0),
  marks_needed: z.number().int().min(1).default(3), // script recomputes = 3 + 2*rank
});

export const ConditionSchema = z.object({
  name: z.string(),
  ticks: z.number().int().nullable(), // null = until-cured
});

export const InventoryItemSchema = z.object({
  id: z.string(), // stable snake_case id, e.g. "rusty_key"
  name: z.string(),
  qty: z.number().int().min(1).default(1),
  equipped: z.boolean().default(false),
  worn: z.boolean().default(false),
  notes: z.string().default(''),
  charges: z.number().int().nullable().default(null),
  seed: z.number().int().nullable().default(null), // sprite seed (M7), = hash(id)
});

// An exit edge. `to` is a room id. `state` mutable; `to`/`type` are topology-locked.
export const ExitSchema = z.object({
  to: z.string(), // room id, e.g. "R02"
  type: z.enum([
    'open',
    'archway',
    'door',
    'portcullis',
    'stairs_up',
    'stairs_down',
    'ladder',
    'hole',
    'crawlspace',
    'secret',
  ]),
  state: z.enum(['open', 'closed', 'locked', 'barred', 'hidden', 'broken']).default('open'),

  // How this link relates to space, for layout (M6, §spec A1). The INTERIOR WIRING,
  // independent of `type` (the fiction): a `type:'archway'` may be `category:'portal'`,
  // a ritual circle that's secretly a trapdoor is `category:'vertical'`. Defaults to
  // 'spatial' so every existing exit grid-walks exactly as before.
  //   spatial  — the eight compass directions; grid-walked into cells.
  //   vertical — up/down between depths (stairs/ladder/hole); a depth-marker, never positioned.
  //   portal   — non-spatial teleport (ritual circle, arch); a named marker, never positioned.
  category: z.enum(['spatial', 'vertical', 'portal']).default('spatial'),

  // The TRUE access requirement (model-authoritative; used to adjudicate attempts).
  // 'none' = freely openable. The others are obstacle SEEDS; overcoming them is the
  // deferred action-resolution layer, not coded here (§spec A2, Deferred).
  lock: z.enum(['none', 'key', 'pickable', 'magical', 'barred', 'sealed']).default('none'),
  // Has the player DISCOVERED this exit's lock nature? Binary for now (one interaction
  // reveals the full lock type). The renderer shows lock styling only when true.
  lock_revealed: z.boolean().default(false),
});

export const RoomContentSchema = z.object({
  id: z.string(),
  name: z.string(),
  qty: z.number().int().min(1).default(1),
  kind: z.enum(['item', 'corpse', 'feature']).default('item'),
});

// `effects` reserved for the post-M3 TTRPG depth layer (design §13). Harmless now.
export const RoomEffectSchema = z.object({
  name: z.string(),
  ticks: z.number().int().nullable(),
});

export const RoomSchema = z.object({
  id: z.string(), // "R03" — immutable once created
  name: z.string(),
  // Dungeon level this room sits on (M6 §spec B1). The model already tracks meta.depth;
  // stamp each room's depth at creation so the automap can filter to the current level.
  // Defaulted to 1 so existing saved rooms remain valid.
  depth: z.number().int().min(1).default(1),
  descr: z.string().default(''),
  exits: z.record(z.string(), ExitSchema).default({}), // keyed by direction
  contents: z.array(RoomContentSchema).default([]),
  effects: z.array(RoomEffectSchema).default([]),
  visited: z.boolean().default(true),
});

export const BestiaryEntrySchema = z.object({
  sprite_fragment: z.string(), // canonical 8-15 word visual, written ONCE
  hp_base: z.number().int().min(1),
  defense: z.number().int().min(1),
  seed: z.number().int().nullable().default(null), // sprite seed (M7)
});

export const CombatMobSchema = z.object({
  id: z.string(), // instance id, e.g. "drowned_02"
  type: z.string(), // bestiary key, e.g. "drowned"
  name: z.string(),
  hp_cur: z.number().int(),
  hp_max: z.number().int().min(1),
  status: z.string().default(''), // "bloodied", "prone", ...
  pos: z.enum(['near', 'far']).default('near'),
});

export const QuestSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().default(false),
});

// ---------- the root ----------

export const DungeonSchema = z.object({
  // `.prefault({})` (not `.default`) so the nested field defaults materialise when
  // seeding from `{}` — `.default` is post-parse and would return a bare `{}`.
  meta: z
    .object({
      turn: z.number().int().min(0).default(0),
      depth: z.number().int().min(1).default(1),
      schema_version: z.string().default('2.0'),
      seed: z
        .number()
        .int()
        .default(() => Math.floor(Math.random() * 2 ** 31)),
    })
    .prefault({}),

  light: z
    .object({
      source: z.string(),
      ticks_remaining: z.number().int().min(0),
    })
    .nullable()
    .default(null),

  player: z
    .object({
      name: z.string().default('Adventurer'),
      class: z.string().default('Wanderer'),
      level: z.number().int().min(1).default(1),
      hp: z
        .object({
          cur: z.number().int().default(10),
          max: z.number().int().min(1).default(10),
        })
        .prefault({}),
      defense: z.number().int().min(1).default(10),
      stats: z
        .object({
          str: z.number().int().default(10),
          dex: z.number().int().default(10),
          con: z.number().int().default(10),
          int: z.number().int().default(10),
          wis: z.number().int().default(10),
          cha: z.number().int().default(10),
        })
        .prefault({}),
      skills: z.record(z.string(), SkillSchema).default({}),
      conditions: z.array(ConditionSchema).default([]),
      location: z.string().default('R01'),
    })
    .prefault({}),

  inventory: z.array(InventoryItemSchema).default([]),
  quest: z.array(QuestSchema).default([]),

  // THE MAP GRAPH. Append-on-discovery. Keyed by room id.
  rooms: z.record(z.string(), RoomSchema).default({}),

  // Canonical mob types: visual fragment + base stats. Append-only.
  bestiary: z.record(z.string(), BestiaryEntrySchema).default({}),

  combat: z
    .object({
      active: z.boolean().default(false),
      mobs: z.array(CombatMobSchema).default([]),
    })
    .prefault({}),

  // Per-turn human-readable change list. Cleared at the start of each turn.
  delta_log: z.array(z.string()).default([]),
});

export type Dungeon = z.infer<typeof DungeonSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Exit = z.infer<typeof ExitSchema>;
export type InventoryItem = z.infer<typeof InventoryItemSchema>;
export type CombatMob = z.infer<typeof CombatMobSchema>;

/**
 * The single chat-scope key everything is namespaced under, so DungeonState
 * never collides with other extensions' chat variables. Mutation-command paths
 * are relative to this (the applier prepends it). See design §5.
 */
export const ROOT_KEY = 'dungeon' as const;

/**
 * Produce a fully-defaulted, valid Dungeon tree. Use as the seed at chargen
 * (M1) before layering the completed character sheet and first room on top.
 */
export function emptyDungeon(): Dungeon {
  return DungeonSchema.parse({});
}
