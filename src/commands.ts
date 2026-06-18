/**
 * commands.ts — the player-facing slash commands (`/map`, `/character`, `/inventory`).
 * Thin display wiring kept OUT of the pure renderers: each `register*Command` takes its
 * capabilities injected (so it unit-tests with fakes, no SillyTavern), and
 * `bootstrapCommands` reads the real `SillyTavern.getContext()` globals and is
 * self-guarding outside ST.
 *
 * Every handler does the same three things: read the current dungeon from chat scope, call
 * a pure renderer, and hand the result to a display sink. Placement is deliberately minimal
 * (a popup) — the quadrant Gold Box panel is M8; the `data-room-id`/`<title>` hooks the
 * renderers already emit make that later wiring free.
 */
import { renderMap } from './map.js';
import { renderInventory, renderSheet } from './sheet.js';
import { type Dungeon } from './schema.js';
import { readDungeon, type VariableStore } from './store.js';

export interface CommandDeps {
  store: VariableStore;
  /** Register a no-arg slash command. */
  registerCommand: (spec: { name: string; helpString: string; callback: () => void }) => void;
  /** Show rendered HTML (popup now; chat-injected panel later). `title` heads the popup. */
  display: (html: string, title: string) => void;
  warn?: (msg: string) => void;
}

/** Render the automap for the player's CURRENT location + depth from stored state. */
export function renderCurrentMap(store: VariableStore, warn?: (m: string) => void): string {
  const d = readDungeon(store, warn);
  return renderMap(d.rooms, d.player.location, d.meta.depth);
}

/**
 * Register a command that renders the current dungeon through `render` and displays it.
 * Returns the bound render function (handy for tests / future panels).
 */
function registerView(
  deps: CommandDeps,
  name: string,
  title: string,
  helpString: string,
  render: (d: Dungeon) => string,
): () => string {
  const run = (): string => render(readDungeon(deps.store, deps.warn));
  deps.registerCommand({ name, helpString, callback: () => deps.display(run(), title) });
  return run;
}

export function registerMapCommand(deps: CommandDeps): () => string {
  return registerView(
    deps,
    'map',
    'Automap',
    'Render the automap for the current depth (current room highlighted).',
    d => renderMap(d.rooms, d.player.location, d.meta.depth),
  );
}

export function registerCharacterCommand(deps: CommandDeps): () => string {
  return registerView(
    deps,
    'character',
    'Character',
    'Show the character sheet (stats, skills, conditions).',
    renderSheet,
  );
}

export function registerInventoryCommand(deps: CommandDeps): () => string {
  return registerView(
    deps,
    'inventory',
    'Inventory',
    'Show the inventory (items, equipped/worn, charges).',
    renderInventory,
  );
}

/** Register all player-facing view commands against one store. */
export function registerAllCommands(deps: CommandDeps): void {
  registerMapCommand(deps);
  registerCharacterCommand(deps);
  registerInventoryCommand(deps);
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
 * Wire `/map`, `/character`, `/inventory` into the running SillyTavern from the shared
 * chat-scope store. No-ops outside ST (e.g. Vitest), so importing this module is harmless.
 * Called from runtime.ts's bootstrap with the same `store` the per-turn pipeline uses.
 */
export function bootstrapCommands(store: VariableStore, warn?: (m: string) => void): void {
  const st = (globalThis as { SillyTavern?: { getContext?: () => StContext } }).SillyTavern;
  const ctx = st?.getContext?.();
  if (!ctx?.SlashCommandParser?.addCommandObject || !ctx.SlashCommand?.fromProps) return;

  const display = (html: string, title: string): void => {
    // Wrap so the content scales to the popup width on mobile (renderers are responsive).
    const content = `<div class="dungeonstate-view" style="width:100%;overflow:auto">${html}</div>`;
    if (ctx.callGenericPopup) {
      ctx.callGenericPopup(content, ctx.POPUP_TYPE?.TEXT ?? 1, title, { wide: true, large: true });
    } else {
      console.info(`[DungeonState] ${title} (no popup available):`, content);
    }
  };

  registerAllCommands({
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
  console.info('[DungeonState] /map, /character, /inventory commands registered.');
}
