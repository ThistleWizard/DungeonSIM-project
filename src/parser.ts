/**
 * parser.ts — extractCommands (milestone M2).
 *
 * Turns a model's `<UpdateDungeon>` block into validated Command objects. Pure
 * function, no SillyTavern dependency — built test-first against
 * extract-commands.spec.md (R1–R11). Technique adapted from MVU's paren-counting
 * extractor, reimplemented clean (we do NOT depend on MVU; see design §1, §3.2).
 */
import JSON5 from 'json5';
import YAML from 'yaml';
import { COMMAND_VERBS, type Command, type CommandType } from './types.js';

const VERB_ALT = COMMAND_VERBS.join('|');
// `_.<verb>(` with tolerant whitespace (R10). New regex per scan to own lastIndex.
const verbPattern = () => new RegExp(`_\\.\\s*(${VERB_ALT})\\s*\\(`, 'g');

const BLOCK_RE = /<UpdateDungeon>([\s\S]*?)(?:<\/UpdateDungeon>|$)/gi;

/**
 * Walk from an opening `(` to its matching `)`, respecting string literals
 * (single/double/backtick, with backslash escapes). Returns the index of the
 * matching `)`, or -1 if none (R3, R7).
 */
function findMatchingCloseParen(s: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  let quote = '';
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        i++; // skip the escaped char
        continue;
      }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = true;
      quote = c;
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split an argument substring (between the call's parens) at top-level commas,
 * ignoring commas inside strings or nested ()/[]/{} (R3, R4).
 */
function splitTopLevelArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let quote = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\') {
        if (i + 1 < s.length) {
          cur += s[i + 1];
          i++;
        }
        continue;
      }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = true;
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '' || parts.length > 0) parts.push(cur);
  return parts;
}

/** Strip one layer of matching surrounding quotes, if present. */
function stripQuotes(token: string): string {
  const t = token.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === "'" || a === '"' || a === '`') && a === b) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Tolerant value parser: JSON → number → JSON5 (single quotes, unquoted keys)
 * → YAML (bare scalars) → raw de-quoted string. See spec R4.
 */
function parseValue(token: string): unknown {
  const t = token.trim();
  if (t === '') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  try {
    return JSON5.parse(t);
  } catch {
    /* fall through */
  }
  try {
    return YAML.parse(t);
  } catch {
    /* fall through */
  }
  return stripQuotes(t);
}

/** Scan a single block body for command calls. */
function scanBody(body: string, out: Command[]): void {
  const re = verbPattern();
  let cursor = 0;
  while (cursor < body.length) {
    re.lastIndex = cursor;
    const m = re.exec(body);
    if (!m) break;

    const verb = m[1] as CommandType;
    const openParen = re.lastIndex - 1; // index of '('
    const close = findMatchingCloseParen(body, openParen);
    if (close === -1) {
      cursor = openParen + 1; // malformed: advance past '(', keep scanning (R7)
      continue;
    }

    // Require the next non-space char to be ';' (R7).
    let j = close + 1;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] !== ';') {
      cursor = openParen + 1;
      continue;
    }
    const semi = j;

    // Optional trailing `//...` comment → reason, captured whole to EOL (R5, R6).
    let reason = '';
    let next = semi + 1;
    let p = next;
    while (p < body.length && body[p] !== '\n' && /\s/.test(body[p])) p++;
    if (body[p] === '/' && body[p + 1] === '/') {
      let end = p + 2;
      while (end < body.length && body[end] !== '\n') end++;
      reason = body.slice(p + 2, end).trim();
      next = end;
    }

    const argsStr = body.slice(openParen + 1, close);
    const parts = splitTopLevelArgs(argsStr);
    if (parts.length === 0) {
      cursor = semi + 1; // no path → skip (R7)
      continue;
    }

    out.push({
      type: verb,
      path: stripQuotes(parts[0]),
      args: parts.slice(1).map(parseValue),
      reason,
      raw: body.slice(m.index, semi + 1),
    });
    cursor = Math.max(next, semi + 1);
  }
}

/**
 * Extract all mutation commands from a model message. Only content inside
 * `<UpdateDungeon>...</UpdateDungeon>` is scanned; everything else (and a message
 * with no block) yields `[]` (R8, R11). Never throws (R7).
 */
export function extractCommands(input: string): Command[] {
  const out: Command[] = [];
  if (!input) return out;
  BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = BLOCK_RE.exec(input)) !== null) {
    if (block[1]) scanBody(block[1], out);
    if (block.index === BLOCK_RE.lastIndex) BLOCK_RE.lastIndex++; // guard against empty match
  }
  return out;
}
