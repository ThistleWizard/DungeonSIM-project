/**
 * rewind.ts — message-scope snapshot model for rewind/swipe safety (milestone M5,
 * design §7).
 *
 * The state engine applies mutations as deltas to chat-scope variables. That drifts
 * the moment the player swipes, regenerates, or deletes back, because chat scope is
 * global to the chat while the narrative just moved. The fix: snapshot the post-turn
 * dungeon into the producing message's SWIPE-INDEXED `message` scope, then restore the
 * right snapshot into chat scope when the timeline moves.
 *
 * The invariant that makes re-rolls correct:
 *
 *   Each AI message's current-swipe snapshot = chat-scope dungeon AFTER that turn.
 *   The pre-turn BASELINE for (re)generating message i = the snapshot of the nearest
 *   PRECEDING message that has one (user messages have none, so the scan skips them).
 *
 * `Timeline` is the only ST-touching surface, injected so the rewind logic is pure and
 * unit-testable. The runtime builds the real one from Tavern Helper's message-scope
 * variable API; tests pass an in-memory fake.
 */
import type { Dungeon } from './schema.js';

export interface Timeline {
  /** Index of the last message, or -1 if the chat is empty. */
  lastIndex(): number;
  /** Our dungeon snapshot stored at a message's CURRENT swipe, or undefined if none. */
  readSnapshot(messageId: number | 'latest'): Dungeon | undefined;
  /** Write our dungeon snapshot into a message's CURRENT swipe. */
  writeSnapshot(messageId: number, dungeon: Dungeon): void;
}

/**
 * The pre-turn baseline for (re)generating the message at `index`: the snapshot of the
 * nearest preceding message that has one. Returns undefined if none exists (e.g. the
 * first turn), letting the caller fall back to an empty dungeon.
 */
export function baselineBefore(timeline: Timeline, index: number): Dungeon | undefined {
  for (let k = index - 1; k >= 0; k--) {
    const snap = timeline.readSnapshot(k);
    if (snap !== undefined) return snap;
  }
  return undefined;
}
