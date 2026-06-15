import { describe, expect, it } from 'vitest';
import { extractCommands } from '../src/parser.js';

/** Wrap raw command lines in the UpdateDungeon block the parser scans. */
const block = (...lines: string[]) => `<UpdateDungeon>\n${lines.join('\n')}\n</UpdateDungeon>`;

describe('extractCommands (extract-commands.spec.md)', () => {
  it('R1 — basic extraction', () => {
    const cmds = extractCommands(block("_.set('a.b', 1, 2);//r"));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: 'set', path: 'a.b', args: [1, 2], reason: 'r' });
  });

  it('R2 — multiple commands in source order', () => {
    const cmds = extractCommands(
      block("_.set('player.hp.cur', 5, 2);//hit", "_.add('player.skills.arcana.marks', 1);//mark", "_.remove('inventory', 'torch_1');//out"),
    );
    expect(cmds.map(c => c.type)).toEqual(['set', 'add', 'remove']);
    expect(cmds.map(c => c.path)).toEqual(['player.hp.cur', 'player.skills.arcana.marks', 'inventory']);
  });

  it('R3 — nested parens / semicolons inside a string arg', () => {
    const cmds = extractCommands(
      block("_.set('rooms.R01.descr', '', 'A vault. Someone scrawled _.set(here); on the wall.');//graffiti"),
    );
    expect(cmds).toHaveLength(1);
    expect(cmds[0].path).toBe('rooms.R01.descr');
    expect(cmds[0].args).toEqual(['', 'A vault. Someone scrawled _.set(here); on the wall.']);
    expect(cmds[0].reason).toBe('graffiti');
  });

  it('R4 — arrays and objects as args (single quotes, unquoted keys)', () => {
    const cmds = extractCommands(
      block("_.set('combat.mobs', [], [{id:'drowned_02',type:'drowned',hp_cur:8,hp_max:8}]);//engaged"),
    );
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args[0]).toEqual([]);
    expect(cmds[0].args[1]).toEqual([{ id: 'drowned_02', type: 'drowned', hp_cur: 8, hp_max: 8 }]);
  });

  it('R5 — reason is optional', () => {
    const cmds = extractCommands(block("_.set('a',1,2);"));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].reason).toBe('');
  });

  it('R6 — reason containing // or URLs is captured whole', () => {
    const cmds = extractCommands(block("_.add('x',1);//see http://e.com//path"));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].reason).toBe('see http://e.com//path');
  });

  it('R7 — malformed command is skipped, not fatal', () => {
    const cmds = extractCommands(
      block(
        "_.set('broken', 1, 2", // missing close paren + semicolon
        "_.set('good', 3, 4);//ok",
      ),
    );
    expect(cmds).toHaveLength(1);
    expect(cmds[0].path).toBe('good');
  });

  it('R7b — missing semicolon is skipped', () => {
    const cmds = extractCommands(block("_.set('a',1,2)", "_.set('b',3,4);"));
    expect(cmds.map(c => c.path)).toEqual(['b']);
  });

  it('R8 — text and parens outside the block are ignored', () => {
    const input = `The hero (bravely) opens a door (creak). ${block("_.add('x',1);//t")} Then prose (with parens).`;
    const cmds = extractCommands(input);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].path).toBe('x');
  });

  it('R9 — all command verbs recognised', () => {
    const verbs = ['set', 'add', 'insert', 'assign', 'remove', 'unset', 'delete', 'move'];
    const cmds = extractCommands(block(...verbs.map(v => `_.${v}('p.${v}', 1);//${v}`)));
    expect(cmds.map(c => c.type)).toEqual(verbs);
  });

  it('R10 — whitespace tolerance around tokens', () => {
    const cmds = extractCommands(block("_.set ( 'a' , 1 , 2 ) ; // r"));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: 'set', path: 'a', args: [1, 2], reason: 'r' });
  });

  it('R11 — empty / no block yields []', () => {
    expect(extractCommands('')).toEqual([]);
    expect(extractCommands('just narrative prose, no block here. _.set(a,1,2);')).toEqual([]);
  });

  it('handles an unterminated block (open tag, no close tag)', () => {
    const cmds = extractCommands("<UpdateDungeon>\n_.add('x',1);//t");
    expect(cmds).toHaveLength(1);
    expect(cmds[0].path).toBe('x');
  });
});
