# extract-commands — parser contract & test spec (milestone M2)

The parser turns a model's `<UpdateDungeon>` block into a list of validated `Command` objects. It is a **pure function** — no SillyTavern dependency — so build it test-first in isolation. Technique adapted from MVU's `extractCommands` (paren-counting state machine), reimplemented clean. See DungeonState-Design.md §3.2.

## Command type

```ts
type CommandType = 'set' | 'add' | 'insert' | 'assign' | 'remove' | 'unset' | 'delete' | 'move';

interface Command {
  type: CommandType;
  path: string;        // lodash path, relative to `dungeon.` (applier prepends)
  args: any[];         // parsed values (after path). set: [old, new]; add: [delta]; etc.
  reason: string;      // text of trailing //comment, trimmed ('' if none)
  raw: string;         // full original matched call, for logging/trace
}

function extractCommands(input: string): Command[]
```

## The syntax the model emits

```
<UpdateDungeon>
_.set('player.hp.cur', 5, 2);//drowned strike
_.add('player.skills.arcana.marks', 1);//successful shadow bolt vs DC>=8
_.set('rooms.R03.exits.east.state', 'locked', 'open');//forced the swollen door
_.remove('inventory', 'torch_1');//burned out
_.set('combat.mobs', [], [{id:'drowned_02',type:'drowned',hp_cur:8,hp_max:8}]);//engaged
</UpdateDungeon>
```

- Three-arg `set`: `path, oldValue, newValue`. Old value is a **confirmation** — applier compares to stored (§5 invariant 4).
- `add`: `path, delta` (numeric).
- `reason` = everything after `//` to end of that statement line, trimmed.

## Hard requirements (these are the test cases)

### R1 — basic extraction
Input one `_.set('a.b', 1, 2);//r` → one command `{type:'set', path:'a.b', args:[1,2], reason:'r'}`.

### R2 — multiple commands
Several statements (newline-separated) → all extracted, in source order.

### R3 — nested parens inside string args (THE hard case)
```
_.set('rooms.R01.descr', '', 'A vault. Someone scrawled _.set(here); on the wall.');//graffiti
```
Must NOT terminate at the inner `);`. Paren-counting required: ignore parens/`;` inside string literals. One command, descr arg intact.

### R4 — arrays and objects as args
```
_.set('combat.mobs', [], [{id:'x',hp_cur:8}]);//spawn
```
`args[1]` parses to a real array-of-object. Use a tolerant parser: try `JSON.parse`, then a JS-literal/`YAML.parse` fallback (MVU's `parseCommandValue` does JSON→number→YAML). Single quotes and unquoted keys should survive via the YAML/literal fallback.

### R5 — reason is optional
`_.set('a',1,2);` with no comment → `reason === ''`.

### R6 — reason containing `//` or URLs
`_.add('x',1);//see http://e.com//path` → reason captured whole, not truncated at the URL's `//`.

### R7 — malformed command is skipped, not fatal
Missing close paren or missing `;` → skip that fragment, continue scanning, return the valid ones. Never throw, never infinite-loop (advance index past the bad open-paren).

### R8 — text outside the block ignored
Prose before/after `<UpdateDungeon>...</UpdateDungeon>`, and the tags themselves, contribute no commands. (Extractor may scan the whole message but only the block should contain calls; ensure prose with incidental parentheses produces nothing.)

### R9 — all command verbs recognised
`set, add, insert, assign, remove, unset, delete, move` each parse with correct `type`. `insert`≈`assign`, `delete`≈`unset` at apply time (normalise later, not in extractor).

### R10 — whitespace tolerance
`_.set ( 'a' , 1 , 2 ) ; // r` (spaces around tokens) still parses.

### R11 — empty / no block
Empty string or no `<UpdateDungeon>` → `[]`.

## Suggested algorithm (reference)

1. Optionally isolate the `<UpdateDungeon>([\s\S]*?)</UpdateDungeon>` body; scan within it.
2. Loop: regex-find next `/_\.(set|add|insert|assign|remove|unset|delete|move)\(/`.
3. From the open paren, `findMatchingCloseParen`: walk chars, track `inString` (respect `'`, `"`, backtick, and escapes), increment/decrement depth on `(`/`)` only when not in a string; stop at depth 0.
4. Require next non-space char is `;`. If not, skip (advance past open paren).
5. Capture optional `//...` to end of line as `reason`.
6. Split the arg substring at top-level commas (same string/paren awareness) → arg tokens.
7. First token with surrounding quotes stripped = `path`; rest run through `parseCommandValue` (JSON → number-with-precision → YAML/literal fallback).
8. Push `Command`. Continue from end of statement.

## Apply-time notes (not the parser's job, but informs arg shape — M3)

- `set` on a scalar: verify `args[0]` == stored (desync check), write `args[1]`, clamp if bounded, push `"old->new (reason)"` to `delta_log`.
- `add` on a number: `stored + args[0]`, clamp, log.
- `remove` on the `inventory` array: `args[0]` is an item id; legality-check qty>0 before decrement/splice.
- `set` on `rooms.*.exits.*`: run topology-lock guard (§5 invariant 1) BEFORE applying; auto-write reciprocal edge.
- Unknown/illegal path or failed invariant: do not apply; push a `[BLOCKED] ...` note to `delta_log` and console.warn. Never corrupt the tree.
