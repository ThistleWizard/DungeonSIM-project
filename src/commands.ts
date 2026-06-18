/**
 * commands.ts — the `/map` slash command (milestone M6, §spec Part C). Thin display
 * wiring kept OUT of the pure renderer: `registerMapCommand` takes its capabilities
 * injected (so it unit-tests with fakes, no SillyTavern), and `bootstrapMapCommand`
 * reads the real `SillyTavern.getContext()` globals and is self-guarding outside ST.
 *
 * The handler does only three things: read the current dungeon from chat scope, call
 * the pure `renderMap`, and hand the SVG to a display sink. Placement is deliberately
 * minimal (a popup) — the quadrant Gold Box panel is M8; the `data-room-id`/`<title>`
 * hooks the renderer already emits make that later wiring free.
 */
import { renderMap } from './map.js';
import { readDungeon, type VariableStore } from './store.js';

export interface MapCommandDeps {
  store: VariableStore;
  /** Register a no-arg slash command. */
  registerCommand: (spec: { name: string; helpString: string; callback: () => void }) => void;
  /** Show rendered HTML (popup now; chat-injected panel later). */
  display: (html: string) => void;
  warn?: (msg: string) => void;
}

/** Render the automap for the player's CURRENT location + depth from stored state. */
export function renderCurrentMap(store: VariableStore, warn?: (m: string) => void): string {
  const d = readDungeon(store, warn);
  return renderMap(d.rooms, d.player.location, d.meta.depth);
}

/**
 * Register `/map`. Returns the render function (handy for tests / future panels). Pure of
 * SillyTavern: every capability is injected.
 */
export function registerMapCommand(deps: MapCommandDeps): () => string {
  const render = (): string => renderCurrentMap(deps.store, deps.warn);
  deps.registerCommand({
    name: 'map',
    helpString: 'Render the DungeonState automap for the current depth (current room highlighted).',
    callback: () => deps.display(render()),
  });
  return render;
}

// ---------- bootstrap (SillyTavern only) ----------

/** The subset of `SillyTavern.getContext()` the command wiring consumes. */
interface StContext {
  SlashCommandParser: { addCommandObject: (cmd: unknown) => void };
  SlashCommand: { fromProps: (props: Record<string, unknown>) => unknown };
  callGenericPopup?: (content: string, type: number, header?: string, options?: Record<string, unknown>) => unknown;
  POPUP_TYPE?: { TEXT?: number };
}

/**
 * Wire `/map` into the running SillyTavern from the shared chat-scope store. No-ops
 * outside ST (e.g. Vitest), so importing this module is harmless. Called from
 * runtime.ts's bootstrap with the same `store` the per-turn pipeline uses.
 */
export function bootstrapMapCommand(store: VariableStore, warn?: (m: string) => void): void {
  const st = (globalThis as { SillyTavern?: { getContext?: () => StContext } }).SillyTavern;
  const ctx = st?.getContext?.();
  if (!ctx?.SlashCommandParser?.addCommandObject || !ctx.SlashCommand?.fromProps) return;

  const display = (html: string): void => {
    // Wrap so the SVG scales to the popup width on mobile (renderMap is already responsive).
    const content = `<div class="dungeonstate-map" style="width:100%;overflow:auto">${html}</div>`;
    if (ctx.callGenericPopup) {
      ctx.callGenericPopup(content, ctx.POPUP_TYPE?.TEXT ?? 1, 'Automap', { wide: true, large: true });
    } else {
      console.info('[DungeonState] /map (no popup available):', content);
    }
  };

  registerMapCommand({
    store,
    warn,
    display,
    registerCommand: spec =>
      ctx.SlashCommandParser.addCommandObject(
        ctx.SlashCommand.fromProps({
          name: spec.name,
          helpString: spec.helpString,
          callback: () => {
            spec.callback();
            return '';
          },
        }),
      ),
  });
  console.info('[DungeonState] /map command registered.');
}
