/**
 * footer.ts — the every-turn MUD status footer (Light / Exits / Here), rendered by the
 * SCRIPT from the post-apply dungeon state and embedded into the AI message.
 *
 * Why this lives here and not in the preset: when the model owned the footer it sat at the
 * very bottom of the prose, immediately before the `<UpdateDungeon>` block — a terminal-shaped
 * MUD closer. On heavy turns the model wrote the footer, felt "done", and dropped the mutation
 * block entirely (state silently froze). Moving the footer into the script makes the
 * `<UpdateDungeon>` block the model's natural LAST output (far harder to forget), and renders
 * the footer from the freshly-applied state — so it can never disagree with the variables
 * (the model used to hand-compute "54 left" from a pre-turn block showing 55).
 *
 * Pure functions → unit-testable. The runtime calls `renderFooter` then `embedFooter`.
 */
import type { Dungeon } from './schema.js';

// Invisible HTML-comment sentinels: present in the raw `mes` (so we can find + replace our own
// footer idempotently) but not shown in the rendered chat bubble.
export const FOOTER_OPEN = '<!--ds-footer-->';
export const FOOTER_CLOSE = '<!--/ds-footer-->';
const FOOTER_BLOCK_RE = /\n*<!--ds-footer-->[\s\S]*?<!--\/ds-footer-->\n*/g;

/** Canonical exit `type` → readable label (e.g. `stairs_down` → "stairs down"). */
function prettyType(type: string): string {
  return type.replace(/_/g, ' ');
}

/**
 * Render the MUD status footer from CURRENT (post-apply) state. Returns '' when there is no
 * room yet (chargen / seed state) so the runtime embeds nothing. Lighting governs visibility:
 * exits are always listed (the way out can be felt for), but room contents are concealed in
 * darkness.
 */
export function renderFooter(d: Dungeon): string {
  // The dead get no status footer. A death turn ends with an epitaph + a new-character prompt;
  // a Light/Exits/Here line for a player who just died (hp 0) reads as incoherent noise.
  if ((d.player?.hp?.cur ?? 1) <= 0) return '';

  const loc = d.player?.location;
  const room = loc ? d.rooms?.[loc] : undefined;
  if (!room) return '';

  const lit = !!d.light;
  const lines: string[] = [];

  // Ambient room light has no ticks (null) — show just the source, no "(N left)".
  const tr = d.light?.ticks_remaining;
  lines.push(lit ? `Light: ${d.light!.source}${tr == null ? '' : ` (${tr} left)`}` : 'Light: none - you stand in darkness');

  const exits = Object.entries(room.exits ?? {}).map(([dir, e]) => {
    const state = e.state && e.state !== 'open' ? `, ${e.state}` : '';
    return `${dir} (${prettyType(e.type)}${state})`;
  });
  lines.push(`Exits: ${exits.length ? exits.join(', ') : 'none'}`);

  if (!lit) {
    lines.push("Here: you can't see - no light.");
  } else {
    const here = (room.contents ?? []).map(c => (c.qty > 1 ? `${c.name} x${c.qty}` : c.name));
    lines.push(here.length ? `Here: ${here.join(', ')}` : 'Here: nothing of note.');
  }

  return lines.join('\n');
}

/** Remove any footer block this module previously embedded (idempotency for re-applied turns). */
export function stripFooter(text: string): string {
  return text.replace(FOOTER_BLOCK_RE, '\n').trimEnd();
}

/**
 * Embed `footerBody` into a model message, sentinel-wrapped. Placed immediately BEFORE the
 * `<UpdateDungeon>` block (where the model used to put it) so reading order stays
 * narration → footer → machine block; appended at the end if there is no block. Idempotent:
 * strips any prior embedded footer first, so re-processing the same message never stacks them.
 */
export function embedFooter(rawText: string, footerBody: string): string {
  const cleaned = stripFooter(rawText);
  const block = `${FOOTER_OPEN}\n${footerBody}\n${FOOTER_CLOSE}`;
  const m = cleaned.match(/<UpdateDungeon>/i);
  if (m && m.index !== undefined) {
    const before = cleaned.slice(0, m.index).trimEnd();
    const rest = cleaned.slice(m.index);
    return `${before}\n\n${block}\n\n${rest}`;
  }
  return `${cleaned}\n\n${block}`;
}
