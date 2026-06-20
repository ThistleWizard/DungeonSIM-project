/**
 * style.ts — the shared 8-bit palette + tiny HTML helpers used by the player-facing
 * renderers (`sheet.ts`, `display.ts`). Keeping the palette and the card wrapper in one
 * place is what makes the four Gold Box tiles read as a single display. The automap
 * (`map.ts`) renders SVG and keeps its own constants, but the hex values are kept in sync
 * with this palette so the panels match.
 */

export const PALETTE = {
  bg: '#0b0d10',
  panel: '#11161d',
  stroke: '#4a5a6a',
  text: '#c9d4df',
  dim: '#6b7886',
  amber: '#e8c468',
  hp: '#b5495b',
  accent: '#3f6e8c',
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

/** A titled 8-bit card with an amber header bar — the common wrapper for every panel. */
export function panel(title: string, inner: string, opts: PanelOptions = {}): string {
  const maxWidth = opts.maxWidth === undefined ? 520 : opts.maxWidth;
  const maxWidthCss = maxWidth == null ? '' : `max-width:${maxWidth}px;`;
  const fillCss = opts.fill ? 'height:100%;' : '';
  return (
    `<div style="font-family:monospace;background:${PALETTE.bg};color:${PALETTE.text};` +
    `border:1px solid ${PALETTE.stroke};border-radius:6px;padding:12px;${maxWidthCss}width:100%;` +
    `box-sizing:border-box;${fillCss}">` +
    `<div style="color:${PALETTE.amber};font-weight:bold;letter-spacing:0.5px;` +
    `border-bottom:1px solid ${PALETTE.stroke};padding-bottom:6px;margin-bottom:10px">${title}</div>` +
    inner +
    `</div>`
  );
}
