# DungeonState — M9 spec: "The Cabinet" (full Gold Box screen shell)

**Status: post-shippable-core. The grail, deliberately last.** This is the most impressive and most RISKY thing on the roadmap — it's the only milestone that reaches into SillyTavern's INTERNALS rather than adding alongside them. Do it AFTER the engine + content + restyle are stable, behind a toggle, desktop-only with a plain-chat fallback. The restyle (separate, done) already gets ~80% of the "it's a real game" look at ~5% of this risk; M9 is the last 20% of immersion at most of the risk.

## The vision
Replace SillyTavern's normal single-column chat with a four-quadrant Gold Box game shell that fills the screen:
```
┌───────────────┬───────────────┐
│  VIEWPORT     │  MAP          │   top: scene-window (sprite) | automap
│  (scene/sprite)│  (automap)   │
├───────────────┼───────────────┤
│  TEXT LOG     │  CHARACTER    │   bottom-left: the narration (ST chat, rehomed)
│  (ST chat)    │  + INVENTORY  │   bottom-right: sheet + items
├───────────────┴───────────────┤
│  > input box ________________  │   custom input → ST's send pipeline
└────────────────────────────────┘
```
The four data tiles are already built (display.ts). M9 adds: (1) the full-screen shell layout, (2) rehoming ST's chat into the bottom-left frame, (3) a custom input that feeds ST.

## Chosen approach: REPARENT, do NOT mirror
Two ways to get ST's text into the frame; the choice is the whole ballgame.

- **REPARENT (chosen):** move ST's actual chat DOM node (`#chat`, inside `#sheld`) into the bottom-left quadrant with JS, and let ST keep managing it. ST still renders messages, streams, handles swipes/edits; your regex display-collapsing still works; you've only relocated the container and styled the frame around it. Robust because you are NOT reimplementing ST's chat — you're rehoming it.
  - Risk: ST's CSS assumes `#chat`/`#sheld` live where ST put them; you fight its stylesheet, and an ST update can move things and break the reparenting. Mitigate: scope your overrides tightly, pin/observe the nodes, and FALL BACK to normal chat if the expected nodes aren't found (never hard-crash the chat).
- **MIRROR (rejected):** read messages from state and re-render your own chat view + own input. Total visual control, but you reimplement streaming, history, swipe display, regex collapsing, and keep it all synced to ST. Month-sinking surface area. Only revisit if reparenting proves truly impossible.

## Input box → ST send pipeline
A custom `<input>`/`<textarea>` in the shell's input frame. On submit, feed the text to ST's normal generation exactly as if typed in its native box, so DungeonState's MESSAGE_RECEIVED processing fires unchanged.
- Preferred: SillyTavern context API — `const ctx = SillyTavern.getContext();` then the send/generate path ST exposes (e.g. set the textarea `#send_textarea` value + trigger ST's send, or use the context's message-send function if available in your ST version). Confirm the exact call against the installed ST version — this is version-sensitive; verify in the live app, don't assume.
- The native input can be hidden (the shell's input replaces it) but keep it in the DOM if ST's send reads from it.
- Keyboard parity: Enter to send, Shift+Enter newline; keep a `/display`-style escape to toggle the shell off.

## The shell layout
- A fixed, full-viewport container (z-index above ST chrome) with a CSS grid: 2 columns × (2 rows + input row). Gold Box framing via the restyle's `panel()` chrome.
- Quadrants: viewport (renderViewport), map (renderMap), text-log (rehomed `#chat`), character (renderSheet + renderInventory stacked, or a sub-tab).
- Reuse the restyle palette/frames so the rehomed chat frame matches the data tiles.
- The four data tiles refresh via the existing `onRefresh` hook (already wired) — they stay in lockstep with state and rewind, exactly as the current panel does.

## HARD REQUIREMENTS (non-negotiable)
1. **Toggleable, default OFF.** Same widget/`/display`-style toggle pattern as the current panel. Plain ST chat is always one click away.
2. **Desktop-only; responsive fallback.** Below a width breakpoint (and on phones), the shell does NOT engage — fall back to normal ST chat (optionally with the existing tabbed panel). A four-quadrant shell + input on a phone is unusable, and the player (you) plays on mobile. The shell is the DESKTOP SHOWCASE, not the universal layout.
3. **Fail-safe rehoming.** If the expected ST nodes (`#chat`, `#sheld`, send path) aren't found (ST update changed them), detect it and fall back to normal chat with a console warn — NEVER leave the player with a broken/empty chat. The shell degrades gracefully or doesn't engage.
4. **No engine coupling.** M9 is pure presentation + ST-DOM glue. It must not touch the state engine, schema, applier, or the mutation pipeline. If something here wants an engine change, that's a smell — rethink it.

## Why this is genuinely riskier than everything prior (read honestly)
Every prior milestone is either pure tested logic (can't break ST) or ADDITIVE UI (a panel beside ST that can't break ST's chat). M9 REPARENTS ST's core DOM and HOOKS its input — the first time the project is coupled to ST internals. ST updates are the standing threat. This is why it's: last, toggled, desktop-only, and fail-safe. Build it when the foundation under it is locked, so when an ST update breaks the shell, the game underneath is untouched and the fallback just works.

## Suggested build order (when M9 starts)
0. **Spike first (throwaway):** before committing, prove on the INSTALLED ST version that (a) `#chat`/`#sheld` reparent cleanly and survive a turn, and (b) a custom input can drive ST's send path. These are the two version-sensitive seams; if either is hostile, that changes the M9 calculus — learn it in an afternoon, not mid-build.
1. Shell layout shell with the four EXISTING tiles + a *placeholder* text frame (no ST yet) — prove the grid/frames on desktop, confirm mobile fallback.
2. Reparent `#chat` into the text frame; confirm ST rendering/streaming/swipes still work inside it; restyle the frame; verify regex collapsing intact.
3. Custom input → ST send; confirm a full turn loop (type → ST generates → response in frame → DungeonState processes mutations → tiles refresh).
4. Fail-safe detection + fallback paths; the toggle; the width breakpoint.
5. Polish: scrollback behavior, input focus, the rehomed chat's frame styling.

## Relationship to other milestones
- Depends on: the restyle (palette/frames/`panel()` — does the chrome; DONE), M5 rewind (tiles already refresh correctly on rewind via onRefresh), M6 map + M7 viewport sprite (fill two quadrants).
- Is NOT depended on by anything — it's the optional cabinet around a game that's fully playable without it. That's exactly why it's safe to do last.
