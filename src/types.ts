/**
 * types.ts — shared types for the DungeonState command pipeline.
 * See extract-commands.spec.md.
 */

export type CommandType = 'set' | 'add' | 'insert' | 'assign' | 'remove' | 'unset' | 'delete' | 'move';

export const COMMAND_VERBS: readonly CommandType[] = [
  'set',
  'add',
  'insert',
  'assign',
  'remove',
  'unset',
  'delete',
  'move',
];

export interface Command {
  /** The verb, e.g. 'set'. */
  type: CommandType;
  /** lodash path, relative to `dungeon.` (the applier prepends the root key). */
  path: string;
  /** Parsed values after the path. set: [old, new]; add: [delta]; remove: [id]; etc. */
  args: unknown[];
  /** Text of the trailing `//` comment, trimmed ('' if none). */
  reason: string;
  /** The full original matched call, for logging/trace. */
  raw: string;
}
