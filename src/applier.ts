/**
 * applier.ts — apply mutation Commands to the dungeon tree, enforcing the §5
 * invariants (milestone M3). This is the milestone that kills drift.
 *
 * `applyCommands` is a PURE function: it deep-clones its input and never touches
 * SillyTavern, so it is fully unit-testable. Runtime wiring (read/write chat-scope
 * variables) lives in store.ts behind an injectable interface.
 *
 * Invariants enforced (design §5):
 *   1. Topology lock on rooms.*.exits.*  (+ reciprocal edge auto-write)
 *   2. Inventory legality (remove/decrement only what's present)
 *   3. Numeric bounds (hp.cur clamped to [0, max])
 *   4. Old-value confirmation (set's claimed old value vs stored → desync flag)
 *   5. Append-only rooms / bestiary (immutable except whitelisted subfields)
 *
 * On any failed invariant: do not apply, push a `[BLOCKED] …` note to delta_log,
 * call the injected logger. Never throw, never corrupt the tree.
 */
import _ from 'lodash';
import type { Dungeon } from './schema.js';
import type { Command } from './types.js';

export interface ApplyOptions {
  /** Logger for blocked/desync notes (default no-op; pass console.warn in runtime). */
  warn?: (msg: string) => void;
  /** Clear delta_log at the start of the turn before applying (default true). */
  clearDeltaLog?: boolean;
}

export interface BlockedEntry {
  cmd: Command;
  reason: string;
}
export interface DesyncEntry {
  cmd: Command;
  stored: unknown;
  claimed: unknown;
}

export interface ApplyResult {
  /** New state (input is never mutated). */
  dungeon: Dungeon;
  /** Per-turn human-readable change list (same array as dungeon.delta_log). */
  delta_log: string[];
  blocked: BlockedEntry[];
  desync: DesyncEntry[];
}

// north/south etc. opposites for reciprocal exit auto-write (invariant 1).
const OPPOSITE: Record<string, string> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  up: 'down',
  down: 'up',
  northeast: 'southwest',
  southwest: 'northeast',
  northwest: 'southeast',
  southeast: 'northwest',
  ne: 'sw',
  sw: 'ne',
  nw: 'se',
  se: 'nw',
};

// Stairs/ladders flip when seen from the far side; everything else mirrors as-is.
const MIRROR_TYPE: Record<string, string> = {
  stairs_up: 'stairs_down',
  stairs_down: 'stairs_up',
};

// Subfields of an EXISTING room that may be mutated (invariant 5).
const MUTABLE_ROOM_FIELDS = new Set(['contents', 'visited', 'effects']);

interface Reciprocal {
  path: string[];
  value: Record<string, unknown>;
}
interface Guard {
  allowed: boolean;
  reason?: string;
  reciprocal?: Reciprocal;
}

interface Ctx {
  log: (msg: string) => void;
  block: (cmd: Command, reason: string) => void;
  desync: (cmd: Command, stored: unknown, claimed: unknown) => void;
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

const reasonSuffix = (cmd: Command) => (cmd.reason ? ` (${cmd.reason})` : '');

// ---------- invariant guards ----------

function computeReciprocal(d: Dungeon, roomId: string, dir: string, value: unknown): Reciprocal | undefined {
  if (!_.isPlainObject(value)) return undefined;
  const opp = OPPOSITE[String(dir).toLowerCase()];
  if (!opp) return undefined; // non-cardinal direction: no automatic reciprocal
  const v = value as Record<string, unknown>;
  const target = v.to;
  if (typeof target !== 'string') return undefined;
  if (!_.has(d, ['rooms', target])) return undefined; // target room not discovered yet — skip
  if (_.has(d, ['rooms', target, 'exits', opp])) return undefined; // already linked — don't overwrite
  const type = v.type as string;
  return {
    path: ['rooms', target, 'exits', opp],
    value: { to: roomId, type: MIRROR_TYPE[type] ?? type, state: v.state ?? 'open' },
  };
}

function guardExits(d: Dungeon, seg: string[], value: unknown, op: 'write' | 'unset'): Guard {
  const roomId = seg[1];
  const dir = seg[3];
  const dirExists = _.has(d, ['rooms', roomId, 'exits', dir]);
  if (op === 'unset') {
    return { allowed: false, reason: `exit '${dir}' cannot be deleted (topology lock)` };
  }
  if (seg.length === 4) {
    // setting the whole exit object
    if (dirExists) {
      return { allowed: false, reason: `exit '${dir}' already exists; cannot redirect/replace (topology lock)` };
    }
    return { allowed: true, reciprocal: computeReciprocal(d, roomId, dir, value) };
  }
  // a subfield of the exit
  if (!dirExists) {
    return { allowed: false, reason: `exit '${dir}' does not exist; add the whole exit first` };
  }
  if (seg[4] === 'state') return { allowed: true };
  return { allowed: false, reason: `exits.${dir}.${seg[4]} is topology-locked` };
}

function guardRooms(d: Dungeon, seg: string[], value: unknown, op: 'write' | 'unset'): Guard {
  const roomId = seg[1];
  if (roomId === undefined) return { allowed: true };
  const roomExists = _.has(d, ['rooms', roomId]);
  if (seg.length === 2) {
    if (op === 'unset') return { allowed: false, reason: `room '${roomId}' cannot be deleted (append-only)` };
    if (roomExists) return { allowed: false, reason: `room '${roomId}' already exists (append-only)` };
    return { allowed: true };
  }
  const field = seg[2];
  if (field === 'exits') return guardExits(d, seg, value, op);
  if (!roomExists) return { allowed: true }; // building a brand-new room incrementally
  if (MUTABLE_ROOM_FIELDS.has(field)) return { allowed: true };
  return { allowed: false, reason: `rooms.${roomId}.${field} is immutable (append-only room)` };
}

function guardBestiary(d: Dungeon, seg: string[], op: 'write' | 'unset'): Guard {
  const key = seg[1];
  if (key === undefined) return { allowed: true };
  const exists = _.has(d, ['bestiary', key]);
  if (seg.length === 2) {
    if (op === 'unset') return { allowed: false, reason: `bestiary '${key}' cannot be deleted (append-only)` };
    if (exists) return { allowed: false, reason: `bestiary '${key}' already exists (append-only)` };
    return { allowed: true };
  }
  if (exists) return { allowed: false, reason: `bestiary.${key} is immutable (append-only)` };
  return { allowed: true };
}

function guardWrite(d: Dungeon, seg: (string | number)[], value: unknown, op: 'write' | 'unset'): Guard {
  // rooms/bestiary paths are record-keyed (no array segments) → seg is all strings there.
  if (seg[0] === 'rooms') return guardRooms(d, seg as string[], value, op);
  if (seg[0] === 'bestiary') return guardBestiary(d, seg as string[], op);
  return { allowed: true };
}

/** Clamp known bounded numeric fields (invariant 3). Non-numbers pass through. */
function clampForPath(d: Dungeon, seg: (string | number)[], value: unknown): unknown {
  if (typeof value !== 'number') return value;
  if (seg[0] === 'player' && seg[1] === 'hp' && seg[2] === 'cur') {
    const max = _.get(d, ['player', 'hp', 'max'], Number.POSITIVE_INFINITY) as number;
    return _.clamp(value, 0, max);
  }
  if (seg[0] === 'combat' && seg[1] === 'mobs' && seg[3] === 'hp_cur') {
    const max = _.get(d, ['combat', 'mobs', seg[2], 'hp_max'], Number.POSITIVE_INFINITY) as number;
    return _.clamp(value, 0, max);
  }
  return value;
}

/**
 * Resolve a mutation path against the LIVE tree, turning id-keyed ARRAY segments into
 * concrete indices so the model can address an array element (inventory item, combat mob,
 * condition, quest, room content) by its `id` (or `name`, for conditions):
 *   `inventory.torch.equipped`  -> ['inventory', 2, 'equipped']
 *   `combat.mobs.drowned_01.hp_cur` -> ['combat', 'mobs', 0, 'hp_cur']
 * Object/record segments pass through unchanged, so `rooms.R05.exits.north` is untouched and
 * the §5 guards (which key off record paths) keep working. Returns null when an id segment
 * lands on an array with no matching element — the verb then blocks with a clear note instead
 * of corrupting the tree (which is what an unresolved `inventory[id:torch].qty` guess did).
 */
function resolvePath(d: Dungeon, path: string): (string | number)[] | null {
  let segs: string[];
  try {
    segs = _.toPath(path);
  } catch {
    return null;
  }
  const concrete: (string | number)[] = [];
  let node: unknown = d;
  for (const seg of segs) {
    if (Array.isArray(node)) {
      const asIndex = Number(seg);
      if (Number.isInteger(asIndex) && String(asIndex) === seg) {
        concrete.push(asIndex);
        node = node[asIndex];
      } else {
        const idx = node.findIndex(
          el => _.isObject(el) && ((el as { id?: unknown }).id === seg || (el as { name?: unknown }).name === seg),
        );
        if (idx === -1) return null; // id/name not present in this array
        concrete.push(idx);
        node = node[idx];
      }
    } else {
      concrete.push(seg);
      node = node == null ? undefined : (node as Record<string, unknown>)[seg];
    }
  }
  return concrete;
}

function applyReciprocal(d: Dungeon, recip: Reciprocal, ctx: Ctx): void {
  _.set(d, recip.path, recip.value);
  ctx.log(`${recip.path.join('.')}: auto-linked -> ${fmt(recip.value)}`);
}

// ---------- per-verb appliers ----------

function applySet(d: Dungeon, cmd: Command, ctx: Ctx): void {
  const { path } = cmd;
  const seg = resolvePath(d, path);
  if (seg === null) return ctx.block(cmd, `set: no array item matching id/name in path '${path}'`);
  const newV = cmd.args[cmd.args.length - 1];
  const guard = guardWrite(d, seg, newV, 'write');
  if (!guard.allowed) return ctx.block(cmd, guard.reason!);

  const stored = _.get(d, seg);
  // Old-value confirmation: set emits [old, new]; compare claimed old to stored.
  // Treat null/undefined as equivalent — adding a brand-new path (e.g. a new exit)
  // reads back as `undefined`, but the preset grammar declares the old value as `null`;
  // both mean "absent", so that is a match, not a desync.
  const claimedOld = cmd.args[0];
  const bothAbsent = stored == null && claimedOld == null;
  if (cmd.args.length >= 2 && !bothAbsent && !_.isEqual(stored, claimedOld)) {
    ctx.desync(cmd, stored, claimedOld);
  }
  const finalV = clampForPath(d, seg, newV);
  _.set(d, seg, finalV);
  ctx.log(`${path}: ${fmt(stored)} -> ${fmt(finalV)}${reasonSuffix(cmd)}`);
  if (guard.reciprocal) applyReciprocal(d, guard.reciprocal, ctx);
}

function applyAdd(d: Dungeon, cmd: Command, ctx: Ctx): void {
  const { path } = cmd;
  const delta = cmd.args[0];
  if (typeof delta !== 'number') return ctx.block(cmd, `add delta '${fmt(delta)}' is not a number`);
  const seg = resolvePath(d, path);
  if (seg === null) return ctx.block(cmd, `add: no array item matching id/name in path '${path}'`);
  const guard = guardWrite(d, seg, undefined, 'write');
  if (!guard.allowed) return ctx.block(cmd, guard.reason!);
  const stored = _.get(d, seg);
  // Use-based growth starts from rank 0: a missing path is the first mark, so
  // treat undefined as 0 and let the delta initialise it. A stored value that
  // EXISTS but is non-numeric is a real type error — still block that.
  const baseVal = stored === undefined ? 0 : stored;
  if (typeof baseVal !== 'number') return ctx.block(cmd, `add target '${path}' is not a number (${fmt(stored)})`);
  const finalV = clampForPath(d, seg, baseVal + delta);
  _.set(d, seg, finalV);
  ctx.log(`${path}: ${baseVal} -> ${finalV}${reasonSuffix(cmd)}`);
}

function applyRemove(d: Dungeon, cmd: Command, ctx: Ctx): void {
  const { path } = cmd;
  const seg = resolvePath(d, path);
  if (seg === null) return ctx.block(cmd, `remove: no array item matching id/name in path '${path}'`);
  const guard = guardWrite(d, seg, undefined, 'write');
  if (!guard.allowed) return ctx.block(cmd, guard.reason!);
  const target = _.get(d, seg);
  if (!Array.isArray(target)) return ctx.block(cmd, `remove target '${path}' is not an array`);
  const id = cmd.args[0];
  const count = typeof cmd.args[1] === 'number' ? cmd.args[1] : 1;

  // Match by element .id, else by deep value equality (invariant 2: must be present).
  let idx = target.findIndex(el => _.isObject(el) && (el as { id?: unknown }).id === id);
  if (idx === -1) idx = target.findIndex(el => _.isEqual(el, id));
  if (idx === -1) return ctx.block(cmd, `remove: '${fmt(id)}' not present in '${path}'`);

  const el = target[idx];
  if (_.isObject(el) && typeof (el as { qty?: unknown }).qty === 'number') {
    const item = el as { qty: number };
    if (item.qty < count) return ctx.block(cmd, `remove: insufficient qty of '${fmt(id)}' in '${path}'`);
    item.qty -= count;
    if (item.qty <= 0) target.splice(idx, 1);
    ctx.log(`${path}: removed ${count}x ${fmt(id)}${reasonSuffix(cmd)}`);
  } else {
    target.splice(idx, 1);
    ctx.log(`${path}: removed ${fmt(id)}${reasonSuffix(cmd)}`);
  }
}

function applyUnset(d: Dungeon, cmd: Command, ctx: Ctx): void {
  const { path } = cmd;
  const seg = resolvePath(d, path);
  if (seg === null) return ctx.block(cmd, `unset: no array item matching id/name in path '${path}'`);
  const guard = guardWrite(d, seg, undefined, 'unset');
  if (!guard.allowed) return ctx.block(cmd, guard.reason!);
  if (!_.has(d, seg)) return ctx.block(cmd, `unset: '${path}' not present`);
  const stored = _.get(d, seg);
  _.unset(d, seg);
  ctx.log(`${path}: unset (was ${fmt(stored)})${reasonSuffix(cmd)}`);
}

function applyAssign(d: Dungeon, cmd: Command, ctx: Ctx): void {
  const { path } = cmd;
  const seg = resolvePath(d, path);
  if (seg === null) return ctx.block(cmd, `${cmd.type}: no array item matching id/name in path '${path}'`);
  const value = cmd.args[cmd.args.length - 1];
  const guard = guardWrite(d, seg, value, 'write');
  if (!guard.allowed) return ctx.block(cmd, guard.reason!);
  const target = _.get(d, seg);
  if (cmd.type === 'insert' && Array.isArray(target)) {
    target.push(value);
    ctx.log(`${path}: inserted ${fmt(value)}${reasonSuffix(cmd)}`);
    return;
  }
  if (_.isPlainObject(target) && _.isPlainObject(value)) {
    _.assign(target as object, value as object);
    ctx.log(`${path}: assigned ${fmt(value)}${reasonSuffix(cmd)}`);
  } else {
    const stored = _.get(d, seg);
    _.set(d, seg, value);
    ctx.log(`${path}: ${fmt(stored)} -> ${fmt(value)}${reasonSuffix(cmd)}`);
  }
  if (guard.reciprocal) applyReciprocal(d, guard.reciprocal, ctx);
}

/**
 * Apply a list of commands to a dungeon tree. Pure: the input is deep-cloned and
 * never mutated; the new tree is returned in `result.dungeon`.
 */
export function applyCommands(input: Dungeon, commands: Command[], opts: ApplyOptions = {}): ApplyResult {
  const d = _.cloneDeep(input);
  const warn = opts.warn ?? (() => {});
  if (opts.clearDeltaLog !== false) d.delta_log = [];
  if (!Array.isArray(d.delta_log)) d.delta_log = [];

  const blocked: BlockedEntry[] = [];
  const desync: DesyncEntry[] = [];
  const ctx: Ctx = {
    log: msg => d.delta_log.push(msg),
    block: (cmd, reason) => {
      const msg = `[BLOCKED] ${cmd.type} ${cmd.path}: ${reason}`;
      d.delta_log.push(msg);
      blocked.push({ cmd, reason });
      warn(msg);
    },
    desync: (cmd, stored, claimed) => {
      const msg = `[DESYNC] ${cmd.path}: stored ${fmt(stored)} but model claimed old ${fmt(claimed)} (applied anyway)`;
      d.delta_log.push(msg);
      desync.push({ cmd, stored, claimed });
      warn(msg);
    },
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'set':
        applySet(d, cmd, ctx);
        break;
      case 'add':
        applyAdd(d, cmd, ctx);
        break;
      case 'remove':
        applyRemove(d, cmd, ctx);
        break;
      case 'unset':
      case 'delete':
        applyUnset(d, cmd, ctx);
        break;
      case 'assign':
      case 'insert':
        applyAssign(d, cmd, ctx);
        break;
      case 'move':
        // Semantics are underspecified (see extract-commands.spec.md); block
        // cleanly rather than guess and corrupt the tree. Revisit if needed.
        ctx.block(cmd, 'move is not supported yet');
        break;
    }
  }

  return { dungeon: d, delta_log: d.delta_log, blocked, desync };
}
