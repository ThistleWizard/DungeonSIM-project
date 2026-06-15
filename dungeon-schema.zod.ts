/**
 * dungeon-schema.zod.ts — DungeonState Phase 2, milestone M1
 * First-draft Zod schema for the chat-scope variable tree.
 * Refine in Claude Code. See DungeonState-Design.md §5.
 *
 * Tavern Helper exposes `z` globally (auto-imports) and `registerVariableSchema`.
 * If building outside ST for unit tests, `import { z } from 'zod'`.
 */

// ---------- leaf shapes ----------

const SkillSchema = z.object({
  rank: z.number().int().min(0).max(5).default(0),
  marks: z.number().int().min(0).default(0),
  marks_needed: z.number().int().min(1).default(3), // script recomputes = 3 + 2*rank
});

const ConditionSchema = z.object({
  name: z.string(),
  ticks: z.number().int().nullable(), // null = until-cured
});

const InventoryItemSchema = z.object({
  id: z.string(),                 // stable snake_case id, e.g. "rusty_key"
  name: z.string(),
  qty: z.number().int().min(1).default(1),
  equipped: z.boolean().default(false),
  worn: z.boolean().default(false),
  notes: z.string().default(''),
  charges: z.number().int().nullable().default(null),
  seed: z.number().int().nullable().default(null), // sprite seed (M7), = hash(id)
});

// An exit edge. `to` is a room id. `state` mutable; `to`/`type` are topology-locked.
const ExitSchema = z.object({
  to: z.string(),                 // room id, e.g. "R02"
  type: z.enum([
    'open', 'archway', 'door', 'portcullis',
    'stairs_up', 'stairs_down', 'ladder', 'hole', 'crawlspace', 'secret',
  ]),
  state: z.enum(['open', 'closed', 'locked', 'barred', 'hidden', 'broken'])
    .default('open'),
});

const RoomContentSchema = z.object({
  id: z.string(),
  name: z.string(),
  qty: z.number().int().min(1).default(1),
  kind: z.enum(['item', 'corpse', 'feature']).default('item'),
});

const RoomSchema = z.object({
  id: z.string(),                 // "R03" — immutable once created
  name: z.string(),
  descr: z.string().default(''),
  exits: z.record(z.string(), ExitSchema).default({}), // keyed by direction
  contents: z.array(RoomContentSchema).default([]),
  visited: z.boolean().default(true),
});

const BestiaryEntrySchema = z.object({
  sprite_fragment: z.string(),    // canonical 8-15 word visual, written ONCE
  hp_base: z.number().int().min(1),
  defense: z.number().int().min(1),
  seed: z.number().int().nullable().default(null), // sprite seed (M7)
});

const CombatMobSchema = z.object({
  id: z.string(),                 // instance id, e.g. "drowned_02"
  type: z.string(),               // bestiary key, e.g. "drowned"
  name: z.string(),
  hp_cur: z.number().int(),
  hp_max: z.number().int().min(1),
  status: z.string().default(''), // "bloodied", "prone", ...
  pos: z.enum(['near', 'far']).default('near'),
});

// ---------- the root ----------

export const DungeonSchema = z.object({
  meta: z.object({
    turn: z.number().int().min(0).default(0),
    depth: z.number().int().min(1).default(1),
    schema_version: z.string().default('2.0'),
    seed: z.number().int().default(() => Math.floor(Math.random() * 2 ** 31)),
  }).default({}),

  light: z.object({
    source: z.string(),
    ticks_remaining: z.number().int().min(0),
  }).nullable().default(null),

  player: z.object({
    name: z.string().default('Adventurer'),
    class: z.string().default('Wanderer'),
    level: z.number().int().min(1).default(1),
    hp: z.object({
      cur: z.number().int().default(10),
      max: z.number().int().min(1).default(10),
    }).default({}),
    defense: z.number().int().min(1).default(10),
    stats: z.object({
      str: z.number().int().default(10),
      dex: z.number().int().default(10),
      con: z.number().int().default(10),
      int: z.number().int().default(10),
      wis: z.number().int().default(10),
      cha: z.number().int().default(10),
    }).default({}),
    skills: z.record(z.string(), SkillSchema).default({}),
    conditions: z.array(ConditionSchema).default([]),
    location: z.string().default('R01'),
  }).default({}),

  inventory: z.array(InventoryItemSchema).default([]),
  quest: z.array(z.object({
    id: z.string(), text: z.string(), done: z.boolean().default(false),
  })).default([]),

  // THE MAP GRAPH. Append-on-discovery. Keyed by room id.
  rooms: z.record(z.string(), RoomSchema).default({}),

  // Canonical mob types: visual fragment + base stats. Append-only.
  bestiary: z.record(z.string(), BestiaryEntrySchema).default({}),

  combat: z.object({
    active: z.boolean().default(false),
    mobs: z.array(CombatMobSchema).default([]),
  }).default({}),

  // Per-turn human-readable change list. Cleared at the start of each turn.
  delta_log: z.array(z.string()).default([]),
});

export type Dungeon = z.infer<typeof DungeonSchema>;

/**
 * Registration sketch (run once, e.g. on script load / chat init):
 *
 *   registerVariableSchema(DungeonSchema, { type: 'chat' });
 *
 * Seed at chargen (M1) — write the completed sheet, the first room, and turn 1:
 *
 *   updateVariablesWith((v) => {
 *     const seeded = DungeonSchema.parse({});      // all defaults
 *     seeded.player = { ...seeded.player, ...sheetFromChargen };
 *     seeded.rooms.R01 = firstRoom;
 *     seeded.meta.turn = 1;
 *     return { ...v, dungeon: seeded };            // namespaced under `dungeon`
 *   }, { type: 'chat' });
 *
 * NOTE on namespacing: store the whole tree under a single `dungeon` key so it
 * never collides with other extensions' chat variables. All paths in mutation
 * commands are then relative to `dungeon.` (the applier prepends it).
 */
