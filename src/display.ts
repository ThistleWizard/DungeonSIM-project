/**
 * display.ts — the Gold Box persistent panel (M8, design §14). Same two-layer split as
 * `map.ts`/`commands.ts`: a PURE `renderDisplay` (unit-testable) + a self-guarding
 * `bootstrapDisplay` that mounts into SillyTavern's DOM (no-ops under Vitest).
 *
 * The panel is a 2×2 dashboard of four tiles — Viewport · Map · Character · Inventory —
 * each a pure render of a slice of the state tree (`renderViewport`, `renderMap`,
 * `renderSheet`, `renderInventory`). ST's chat stays the narration/"text" zone (§14). The
 * layout is CONTAINER-responsive: wide panel → 2×2 quadrants; narrow (slim dock or phone)
 * → single column + a tab bar. Toggleable, default OFF — plain chat is always playable.
 *
 * It updates every turn (and on every rewind) because `bootstrapDisplay` returns a `refresh`
 * that runtime.ts registers via `onRefresh`, which fires wherever state changes — so the
 * panel can never disagree with the chat (the §14 M5 dependency, satisfied for free).
 */
import { renderMap } from './map.js';
import { renderInventory, renderSheet } from './sheet.js';
import { type Dungeon } from './schema.js';
import { readDungeon, type VariableStore } from './store.js';
import { PALETTE as C, esc, panel } from './style.js';

const TABS = [
  { id: 'viewport', label: 'View' },
  { id: 'map', label: 'Map' },
  { id: 'character', label: 'Char' },
  { id: 'inventory', label: 'Items' },
] as const;

type TabId = (typeof TABS)[number]['id'];
const DEFAULT_TAB: TabId = 'map';

/** Scoped, container-responsive CSS for the panel's INNER chrome (grid + tabs). */
const DISPLAY_STYLE =
  `<style>` +
  `.ds-display{container-type:inline-size;font-family:monospace;background:${C.bg};color:${C.text}}` +
  `.ds-display *{box-sizing:border-box}` +
  `.ds-display .ds-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:8px}` +
  `.ds-display .ds-tile{min-width:0;display:none}` +
  `.ds-display .ds-tile.ds-active{display:block}` +
  `.ds-display .ds-tabs{display:flex;gap:4px;padding:8px 8px 0}` +
  `.ds-display .ds-tab{flex:1;background:${C.panel};color:${C.text};border:1px solid ${C.stroke};` +
  `border-radius:4px;padding:6px 4px;font-family:monospace;font-size:12px;cursor:pointer}` +
  `.ds-display .ds-tab.ds-active{color:${C.amber};border-color:${C.amber}}` +
  // Wide enough to show all four at once → 2×2 quadrants, tab bar hidden.
  `@container (min-width:480px){` +
  `.ds-display .ds-grid{grid-template-columns:1fr 1fr}` +
  `.ds-display .ds-tile{display:block}` +
  `.ds-display .ds-tabs{display:none}}` +
  `</style>`;

/** The viewport tile. Until M7 sprites land, a live text stand-in (current scene / combat). */
export function renderViewport(d: Dungeon): string {
  let body: string;
  if (d.combat?.active && d.combat.mobs?.length) {
    const mobs = d.combat.mobs
      .map(m => {
        const status = m.status ? ` <span style="color:${C.dim}">${esc(m.status)}</span>` : '';
        return `<div>${esc(m.name)} <span style="color:${C.dim}">HP ${m.hp_cur}/${m.hp_max}</span>${status}</div>`;
      })
      .join('');
    body = `<div style="color:${C.hp};margin-bottom:4px">⚔ Facing</div>${mobs}`;
  } else {
    const room = d.player?.location ? d.rooms?.[d.player.location] : undefined;
    body = `<div style="color:${C.text}">${room ? esc(room.name) : 'the dark'}</div>`;
  }
  const inner =
    `<div data-viewport style="text-align:center;padding:14px 8px">` +
    body +
    `<div style="color:${C.dim};font-size:10px;margin-top:10px">[sprite arrives with M7]</div></div>`;
  return panel('VIEWPORT', inner, { fill: true, maxWidth: null });
}

export interface DisplayOptions {
  /** Which tile is active in narrow/tabbed mode. Default 'map'. */
  activeTab?: TabId;
}

/** Render the whole panel's inner HTML from current state. Pure + deterministic. */
export function renderDisplay(d: Dungeon, opts: DisplayOptions = {}): string {
  const active = opts.activeTab ?? DEFAULT_TAB;
  const tiles: Record<TabId, string> = {
    viewport: renderViewport(d),
    map: renderMap(d.rooms, d.player.location, d.rooms?.[d.player.location]?.depth ?? d.meta.depth),
    character: renderSheet(d),
    inventory: renderInventory(d),
  };
  const tabBar =
    `<div class="ds-tabs">` +
    TABS.map(
      t => `<button class="ds-tab${t.id === active ? ' ds-active' : ''}" data-tab="${t.id}">${t.label}</button>`,
    ).join('') +
    `</div>`;
  const grid =
    `<div class="ds-grid">` +
    TABS.map(
      t => `<div class="ds-tile${t.id === active ? ' ds-active' : ''}" data-tab="${t.id}">${tiles[t.id]}</div>`,
    ).join('') +
    `</div>`;
  return DISPLAY_STYLE + tabBar + grid;
}

// ---------- bootstrap (SillyTavern only) ----------

const ROOT_ID = 'ds-display-root';
const POS_STYLE_ID = 'ds-display-pos';
const VIS_KEY = 'ds-display-visible';

/** Fixed right-rail dock + the body-class hook that reflows chat when the panel is on. */
const POSITION_CSS =
  `#${ROOT_ID}{position:fixed;top:0;right:0;height:100vh;width:min(560px,46vw);overflow:auto;` +
  `z-index:3000;border-left:1px solid ${C.stroke};box-shadow:-2px 0 10px rgba(0,0,0,.5)}` +
  `body.ds-display-on #sheld{margin-right:min(560px,46vw)}` +
  `@media (max-width:480px){#${ROOT_ID}{width:100vw}body.ds-display-on #sheld{margin-right:0}}`;

function injectStyleOnce(doc: Document, id: string, css: string): void {
  if (doc.getElementById(id)) return;
  const el = doc.createElement('style');
  el.id = id;
  el.textContent = css;
  doc.head.appendChild(el);
}

/**
 * Mount the panel, register the input-bar "Display" toggle button (Tavern Helper script
 * button) + a `/display` command, and return a `refresh()` for runtime.ts to drive each turn.
 * Returns undefined outside Tavern Helper so importing this is harmless under Vitest.
 */
export function bootstrapDisplay(store: VariableStore, warn?: (m: string) => void): (() => void) | undefined {
  const g = globalThis as any;
  const parentDoc: Document | undefined = g.parent?.document;
  const $ = g.$ ?? g.jQuery;
  const replaceScriptButtons = g.replaceScriptButtons;
  const eventOnButton = g.eventOnButton;
  if (
    !parentDoc ||
    typeof $ !== 'function' ||
    typeof replaceScriptButtons !== 'function' ||
    typeof eventOnButton !== 'function'
  ) {
    return undefined; // not inside Tavern Helper
  }

  let activeTab: TabId = DEFAULT_TAB;
  const isNarrow = (): boolean => (g.innerWidth ?? 1024) < 480;
  // Default OFF (§14). Sticky on desktop if the player turned it on before; never auto-on on phones.
  let visible = !isNarrow() && g.localStorage?.getItem?.(VIS_KEY) === '1';

  injectStyleOnce(parentDoc, POS_STYLE_ID, POSITION_CSS);

  let $root = $(`#${ROOT_ID}`, parentDoc);
  if ($root.length === 0) {
    $root = $(`<div id="${ROOT_ID}" class="ds-display"></div>`);
    $('body', parentDoc).append($root);
    // Tab switching (narrow mode): swap the active tile without a full state re-render.
    $root.on('click', '.ds-tab', function (this: HTMLElement) {
      activeTab = ($(this).attr('data-tab') as TabId) || DEFAULT_TAB;
      $root.find('.ds-tile,.ds-tab').removeClass('ds-active');
      $root.find(`[data-tab="${activeTab}"]`).addClass('ds-active');
    });
  }

  const render = (): void => {
    $root.html(renderDisplay(readDungeon(store, warn), { activeTab }));
  };
  const applyVisibility = (): void => {
    $root.attr('hidden', visible ? null : 'hidden');
    $('body', parentDoc).toggleClass('ds-display-on', visible);
  };
  const refresh = (): void => {
    if (visible) render();
  };
  const toggle = (): void => {
    visible = !visible;
    g.localStorage?.setItem?.(VIS_KEY, visible ? '1' : '0');
    applyVisibility();
    refresh();
  };

  // Control widget: an input-bar script button + a /display slash command (keyboard parity).
  try {
    replaceScriptButtons([{ name: 'Display', visible: true }]);
    eventOnButton('Display', toggle);
  } catch (err) {
    warn?.(`[DungeonState] could not register Display button: ${err}`);
  }
  const ctx = g.SillyTavern?.getContext?.();
  if (ctx?.SlashCommandParser?.addCommandObject && ctx.SlashCommand?.fromProps) {
    ctx.SlashCommandParser.addCommandObject(
      ctx.SlashCommand.fromProps({
        name: 'display',
        helpString: 'Toggle the Gold Box display panel (map, character, inventory, viewport).',
        callback: () => {
          toggle();
          return '';
        },
      }),
    );
  }

  applyVisibility();
  refresh();
  return refresh;
}
