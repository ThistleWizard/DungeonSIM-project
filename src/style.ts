/**
 * style.ts — the shared Gold Box palette + tiny HTML helpers used by the player-facing
 * renderers (`sheet.ts`, `display.ts`, `footer` chrome). Keeping the palette and the card
 * wrapper in one place is what makes the four tiles read as a single display. The automap
 * (`map.ts`) renders SVG and keeps its own constants, but the hex values are kept in sync
 * with this palette so the panels match (see the MAP SYNC note at the bottom).
 *
 * The look: SSI Gold Box / Wizardry. Deep navy-black, parchment + gold, beveled double-line
 * frames with a recessed title bar. Pairs with a pixel webfont (see FONT note) for the full
 * DOS-CRPG feel. Swapping PALETTE reskins the whole UI; exports/signatures are stable so no
 * renderer needs to change.
 */

// ---------------------------------------------------------------------------
// PALETTE — 16-ish color SSI-flavored set. Swap these and the whole UI reskins.
// ---------------------------------------------------------------------------
export const PALETTE = {
  bg: '#0a0a18', // near-black navy — the SSI dungeon void
  panel: '#141026', // dark indigo panel fill
  stroke: '#c8a84a', // MAIN GOLD border
  text: '#d8c8a0', // parchment
  dim: '#7a6a4a', // faded parchment (secondary text)
  amber: '#f0d878', // bright gold (titles, highlights, lit things)
  hp: '#c43a3a', // blood red (HP, danger)
  accent: '#5a7ab8', // EGA blue (map edges, links)
  // extra tokens the Gold Box chrome uses (additive — old code ignores them):
  frameLt: '#8a7a3a', // gold bevel highlight (top/left)
  frameDk: '#3a3018', // gold bevel shadow (bottom/right) + title-bar fill
  stone: '#2a2a3a', // scene-window stone fill (viewport)
  green: '#5a9a4a', // EGA green (nature/goblin sprites placeholder)
} as const;

/** Escape text for safe interpolation into HTML/SVG. Coerces non-strings (undefined, an
 *  array, a number) to a string first, so malformed/partial state can never throw mid-render
 *  and kill a panel refresh — the applier tolerates bad data, the renderers must too. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PanelOptions {
  /** Cap the card width (px). `null` = no cap (fill the container/grid cell). Default 520. */
  maxWidth?: number | null;
  /** Stretch to fill the container height (for grid tiles). Default false. */
  fill?: boolean;
}

/**
 * A Gold Box card: beveled gold double-frame with a recessed title bar. Same signature as
 * before, so it's a drop-in for every caller.
 *
 * FONT note: for the full effect, load a pixel/bitmap webfont once (ST custom CSS or an
 * @font-face in the panel CSS) and it will apply here. "Px437 IBM VGA 8x16" gives authentic
 * DOS-CRPG; a softer pixel font ("Silkscreen", "Pixelify Sans") is gentler against prose.
 * Falls back to monospace if absent.
 */
const FONT = `"Px437 IBM VGA 8x16", "Silkscreen", monospace`;

export function panel(title: string, inner: string, opts: PanelOptions = {}): string {
  const maxWidth = opts.maxWidth === undefined ? 520 : opts.maxWidth;
  const maxWidthCss = maxWidth == null ? '' : `max-width:${maxWidth}px;`;
  const fillCss = opts.fill ? 'height:100%;' : '';
  // Outer: gold border + raised bevel (light top-left, dark bottom-right) via box-shadow insets.
  const frame =
    `font-family:${FONT};background:${PALETTE.panel};color:${PALETTE.text};` +
    `border:2px solid ${PALETTE.stroke};border-radius:2px;` +
    `box-shadow:inset 2px 2px 0 ${PALETTE.frameLt},inset -2px -2px 0 ${PALETTE.frameDk};` +
    `${maxWidthCss}width:100%;box-sizing:border-box;${fillCss}` +
    `display:flex;flex-direction:column;overflow:hidden`;
  // Title bar: recessed dark strip, centered bright-gold caps with the — TITLE — flourish.
  const titleBar =
    `background:${PALETTE.frameDk};color:${PALETTE.amber};` +
    `text-align:center;font-weight:bold;letter-spacing:1px;` +
    `padding:4px 8px;border-bottom:1px solid ${PALETTE.stroke};text-transform:uppercase`;
  const bodyPad = `padding:10px;flex:1;min-height:0;overflow:auto`;
  return (
    `<div style="${frame}">` +
    `<div style="${titleBar}">— ${esc(title)} —</div>` +
    `<div style="${bodyPad}">${inner}</div>` +
    `</div>`
  );
}

/* ---------------------------------------------------------------------------
 * MAP SYNC: map.ts keeps its own SVG color constants. To match this palette,
 * set there: bg→#0a0a18, room stroke→#c8a84a (gold), current-room→#f0d878,
 * edges→#5a7ab8 (EGA blue), stub/dim→#7a6a4a, room fill→#141026 (panel indigo),
 * text→#d8c8a0 (parchment). Kept in sync as of the Gold Box restyle.
 * --------------------------------------------------------------------------- */
