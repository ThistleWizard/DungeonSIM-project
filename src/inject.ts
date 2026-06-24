/**
 * inject.ts — render the compact, authoritative [CURRENT STATE] block the script
 * feeds the model each turn (milestone M4, design §6).
 *
 * This is the "thin injection": only *situational* truth (current room + exits,
 * sheet, inventory, active combat) — NOT the whole map graph or bestiary, which
 * stay in storage. That is the token win that lets the model stop re-emitting the
 * world. Pure function → unit-testable.
 */
import type { Dungeon } from './schema.js';

function exitLine(dir: string, e: { to: string | null; type: string; state?: string }): string {
  const state = e.state && e.state !== 'open' ? `, ${e.state}` : '';
  const dest = e.to ?? '?'; // null = unexplored (destination not yet discovered)
  return `${dir}->${dest} (${e.type}${state})`;
}

export function formatStateBlock(d: Dungeon): string {
  const lines: string[] = ['[CURRENT STATE — authoritative, obey over your own memory]'];

  const m = d.meta ?? ({} as Dungeon['meta']);
  // Ambient room light has no ticks (null) — show just the source.
  const light = d.light
    ? d.light.ticks_remaining == null
      ? d.light.source
      : `${d.light.source} (${d.light.ticks_remaining})`
    : 'none';
  lines.push(`Turn ${m?.turn ?? 0} | Depth ${m?.depth ?? 1} | Light: ${light}`);

  const loc = d.player?.location;
  const room = loc ? d.rooms?.[loc] : undefined;
  if (room) {
    const exits =
      Object.entries(room.exits ?? {})
        .map(([dir, e]) => exitLine(dir, e))
        .join(', ') || 'none';
    lines.push(`You are in ${room.name} (${room.id}). Exits: ${exits}.`);
    const here = (room.contents ?? []).map(c => (c.qty > 1 ? `${c.name} x${c.qty}` : c.name));
    if (here.length) lines.push(`Here: ${here.join(', ')}`);
    const effects = (room.effects ?? []).map(e => (e.ticks != null ? `${e.name}(${e.ticks})` : e.name));
    if (effects.length) lines.push(`Room effects: ${effects.join(', ')}`);
  } else if (loc) {
    lines.push(`You are at ${loc} (unmapped).`);
  }

  const p = d.player;
  if (p) {
    const conds = (p.conditions ?? []).map(c => (c.ticks != null ? `${c.name}(${c.ticks})` : c.name));
    let sheet = `HP ${p.hp?.cur}/${p.hp?.max} | Defense ${p.defense}`;
    if (conds.length) sheet += ` | ${conds.join(', ')}`;
    lines.push(sheet);
    const skills = Object.entries(p.skills ?? {}).map(([n, s]) => `${n} ${s.rank}`);
    if (skills.length) lines.push(`Skills: ${skills.join(', ')}`);
  }

  const inv = (d.inventory ?? []).map(it => {
    let s = it.qty > 1 ? `${it.name} x${it.qty}` : it.name;
    const tags = [
      it.equipped ? 'equipped' : '',
      it.worn ? 'worn' : '',
      it.charges != null ? `${it.charges} charges` : '',
      // Light-source burn state (script-owned) so the model sees which torch is lit and its fuel.
      it.fuel != null ? (it.lit ? `lit, ${it.fuel} left` : `unlit, ${it.fuel} fuel`) : '',
    ].filter(Boolean);
    if (tags.length) s += ` (${tags.join(', ')})`;
    return s;
  });
  lines.push(`Carrying: ${inv.length ? inv.join(', ') : 'nothing'}`);

  if (d.combat?.active && d.combat.mobs?.length) {
    lines.push('Combat:');
    for (const mob of d.combat.mobs) {
      const status = mob.status ? ` (${mob.status})` : '';
      lines.push(`  ${mob.id} ${mob.name} HP ${mob.hp_cur}/${mob.hp_max}${status} [${mob.pos}]`);
    }
  }

  const quests = (d.quest ?? []).filter(q => !q.done).map(q => q.text);
  if (quests.length) lines.push(`Quests: ${quests.join(' | ')}`);

  return lines.join('\n');
}
