# Loading DungeonState into SillyTavern (first playtest)

This gets the Phase-2 state engine running for **linear play**. It is the M4.5 bridge — the
pure core (M1–M4) wired into Tavern Helper. Rewind/swipe safety (M5) is **not** here yet; see
the caveat at the bottom.

## What you need

- SillyTavern with the **Tavern Helper** (JS-Slash-Runner) extension installed.
- This repo, with Node installed.

## 1. Build the script

```bash
npm install
npm run build:script      # → dist/dungeonstate.js  (one self-contained file)
```

`dist/dungeonstate.js` is the artifact you load. Rebuild it whenever you change `src/`.
(It is git-ignored and generated — never hand-edit it.)

## 2. Load the script into Tavern Helper

1. Open Tavern Helper → **Script Library** (脚本库) → add a **new script**.
2. Name it `DungeonState`, paste the entire contents of `dist/dungeonstate.js` into the
   content box, save, and **enable** it.
3. You do **not** need the "macro-like" / front-end feature toggle — DungeonState injects its
   state block via the prompt-injection API, not via a `{{...}}` macro.

On load you should see in the browser console:
`[DungeonState] runtime initialised (chat-scope state, [CURRENT STATE] injection).`

## 3. Import the Phase-2 preset

1. In SillyTavern, import **`DungeonSIM-Phase2.json`** as your chat-completion preset and
   select it. (This is the forked preset that emits `<UpdateDungeon>` mutations and reads the
   injected `[CURRENT STATE]` block — not the Phase-1 `DungeonSIM.json`.)
2. Use a capable model (the preset assumes strong instruction-following).

## 3b. Theme SillyTavern to match (optional, recommended)

The display panel is themed by the script. To make ST's own chat/chrome match it (Gold Box
look — stone-gray, gold frames, VT323 narration, Silkscreen UI), paste the entire contents of
**`goldbox-st-theme.css`** into **SillyTavern → User Settings → Custom CSS**. The webfonts are
loaded by the script (not the CSS), so **do not add an `@import`** — it breaks ST's Custom CSS
box (the file header explains why).

## 4. Play

1. Start a **fresh chat**. The state is empty, so the preset's chargen gate fires — roll up a
   character. The script captures the seeding `<UpdateDungeon>` block and writes the initial
   tree.
2. Take a few turns. Each turn the model emits an `<UpdateDungeon>` block; the script parses
   it, enforces the §5 invariants, applies the deltas to chat-scope variables, and refreshes
   the `[CURRENT STATE]` injection for the next turn.

## 5. Confirm it's working

- **Tavern Helper → Variables panel** (chat scope): you should see a `dungeon` tree —
  `dungeon.player.hp`, `dungeon.meta.turn`, `dungeon.rooms.*`, `dungeon.inventory`, etc.
  growing as you play.
- **Prompt itemizer / prompt viewer**: a `[CURRENT STATE — authoritative…]` system block
  should appear near the bottom of the outgoing prompt.
- **`dungeon.delta_log`**: a human-readable list of the changes from the **last** turn.
  `[BLOCKED]` / `[DESYNC]` lines there (and `console.warn`, plus a toast) flag a rejected
  mutation or an old-value mismatch — visible, never silent.
- Persistence: HP / turn / light / discovered rooms should carry across turns without the
  model re-narrating the whole world.

## Rewind & swipes (M5)

State follows the timeline. After each turn the post-turn dungeon is snapshotted into that
message's **swipe-indexed** message-scope variables; on rewind the right snapshot is restored
into chat scope. So these are now safe:

- **Swipe** an AI message to a new generation → state is computed from the pre-turn baseline,
  not stacked on the previous swipe.
- **Swipe back** to an earlier swipe → chat-scope state matches that branch.
- **Regenerate** the last message → no double-apply.
- **Delete** the last message → state rolls back to the previous turn.

Documented gaps (by design for M5): **manual text edits** to a message do **not** recompute
state (an edited `<UpdateDungeon>` block won't re-run — treated as intentional); jumping back
many messages / branch checkout beyond swipe/delete of the tail is best-effort; `continue` /
`impersonate` / `quiet` generations are skipped by the apply path. If state ever looks wrong,
inspect `dungeon.delta_log` and the variables panel; you can hand-edit the `dungeon` variable
in Tavern Helper to recover.

## Troubleshooting

- **No `dungeon` variable appears:** confirm the script is enabled and the console shows the
  init line; confirm the model actually emitted an `<UpdateDungeon>` block (check the raw
  message).
- **`[CURRENT STATE]` not in the prompt:** make sure you selected the Phase-2 preset, and that
  the script loaded before the generation (reload the chat after enabling).
- **Everything `[BLOCKED]`:** likely a preset/grammar mismatch — the preset must emit paths
  relative to the dungeon root (no `dungeon.` prefix), using only `set/add/insert/remove/
  assign/unset`.
