/**
 * sheet.ts — player-facing Gold Box renderers (M8 prep): the character sheet and the
 * inventory, rendered as styled HTML straight from the deterministic state tree. Pure
 * functions, no SillyTavern — same discipline as `map.ts`.
 *
 * These are the SAME anti-drift move as the automap: the engine prints the sheet from
 * `player.*` / `inventory[]`, so it can never disagree with stored state. Unlike the map
 * (knowledge-gated) and the model-facing `[CURRENT STATE]` block (`inject.ts`), these show
 * the FULL player-known truth — your character knows their own stats and pack.
 *
 * Styling is inline (popups don't reliably load external CSS) and reuses the map's 8-bit
 * palette so the panels read as one display when M8 assembles them.
 */
import type { Dungeon } from './schema.js';
import { PALETTE as C, esc, panel } from './style.js';

function bar(cur: number, max: number, color: string): string {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
  return (
    `<div style="background:${C.panel};border:1px solid ${C.stroke};border-radius:3px;height:14px;` +
    `position:relative;overflow:hidden">` +
    `<div style="background:${color};height:100%;width:${pct}%"></div></div>`
  );
}

// ---------- character sheet ----------

export function renderSheet(d: Dungeon): string {
  const p = d.player;
  const rows: string[] = [];

  rows.push(
    `<div style="font-size:15px;margin-bottom:2px"><span style="color:${C.amber}">${esc(p.name)}</span></div>` +
      `<div style="color:${C.dim};margin-bottom:10px">${esc(p.class)} · Level ${p.level}</div>`,
  );

  // Vitals: HP bar + defense + light.
  const light = d.light ? `${esc(d.light.source)} (${d.light.ticks_remaining})` : 'none';
  rows.push(
    `<div style="display:flex;justify-content:space-between;margin-bottom:3px">` +
      `<span>HP</span><span>${p.hp.cur} / ${p.hp.max}</span></div>` +
      bar(p.hp.cur, p.hp.max, C.hp) +
      `<div style="display:flex;justify-content:space-between;margin-top:8px">` +
      `<span style="color:${C.dim}">Defense</span><span>${p.defense}</span></div>` +
      `<div style="display:flex;justify-content:space-between">` +
      `<span style="color:${C.dim}">Light</span><span>${light}</span></div>`,
  );

  // Stat grid.
  const stats = p.stats as Record<string, number>;
  const statCells = ['str', 'dex', 'con', 'int', 'wis', 'cha']
    .map(
      k =>
        `<div style="flex:1 0 30%;background:${C.panel};border:1px solid ${C.stroke};border-radius:3px;` +
        `padding:4px 6px;margin:3px;text-align:center">` +
        `<div style="color:${C.dim};font-size:11px">${k.toUpperCase()}</div>` +
        `<div style="font-size:15px">${stats[k] ?? '—'}</div></div>`,
    )
    .join('');
  rows.push(
    `<div style="color:${C.amber};margin:12px 0 2px">ABILITIES</div>` +
      `<div style="display:flex;flex-wrap:wrap;margin:-3px">${statCells}</div>`,
  );

  // Skills with rank dots + marks toward the next rank.
  const skills = Object.entries(p.skills ?? {});
  if (skills.length) {
    const skillRows = skills
      .map(([name, s]) => {
        const dots = '●'.repeat(s.rank) + '○'.repeat(Math.max(0, 5 - s.rank));
        return (
          `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">` +
          `<span>${esc(name)}</span>` +
          `<span><span style="color:${C.accent};letter-spacing:1px">${dots}</span> ` +
          `<span style="color:${C.dim};font-size:11px">${s.marks}/${s.marks_needed}</span></span></div>`
        );
      })
      .join('');
    rows.push(`<div style="color:${C.amber};margin:12px 0 2px">SKILLS</div>${skillRows}`);
  }

  // Conditions (ticks null = until cured → ∞).
  const conds = p.conditions ?? [];
  if (conds.length) {
    const chips = conds
      .map(
        c =>
          `<span style="display:inline-block;background:${C.panel};border:1px solid ${C.stroke};` +
          `border-radius:10px;padding:1px 8px;margin:2px;font-size:12px">` +
          `${esc(c.name)} <span style="color:${C.dim}">${c.ticks == null ? '∞' : c.ticks}</span></span>`,
      )
      .join('');
    rows.push(`<div style="color:${C.amber};margin:12px 0 4px">CONDITIONS</div><div>${chips}</div>`);
  }

  return panel('CHARACTER', rows.join(''));
}

// ---------- inventory ----------

export function renderInventory(d: Dungeon): string {
  const items = d.inventory ?? [];
  if (items.length === 0) {
    return panel('INVENTORY', `<div style="color:${C.dim}">You are carrying nothing.</div>`);
  }

  const rows = items
    .map(it => {
      const tags = [
        it.equipped ? 'equipped' : '',
        it.worn ? 'worn' : '',
        it.charges != null ? `${it.charges} charges` : '',
        // Light-source burn state (script-owned): a clear lit/unlit indicator + remaining fuel.
        it.fuel != null ? (it.lit ? `🔥 lit · ${it.fuel}` : `unlit · ${it.fuel}`) : '',
      ].filter(Boolean);
      const tagHtml = tags.length
        ? ` <span style="color:${C.accent};font-size:11px">[${tags.map(esc).join(' · ')}]</span>`
        : '';
      const qty = it.qty > 1 ? ` <span style="color:${C.dim}">×${it.qty}</span>` : '';
      const notes = it.notes
        ? `<div style="color:${C.dim};font-size:11px;margin-left:10px">${esc(it.notes)}</div>`
        : '';
      return (
        `<div style="padding:4px 0;border-bottom:1px solid ${C.panel}">` +
        `<div>${esc(it.name)}${qty}${tagHtml}</div>${notes}</div>`
      );
    })
    .join('');

  return panel('INVENTORY', rows);
}
