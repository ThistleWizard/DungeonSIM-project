import { describe, expect, it } from 'vitest';
import { baselineBefore, type Timeline } from '../src/rewind.js';
import { DungeonSchema, type Dungeon } from '../src/schema.js';

const d = (hp: number): Dungeon => DungeonSchema.parse({ player: { hp: { cur: hp, max: 10 } } });

/** Minimal Timeline backed by a flat per-index snapshot array. */
function tlFrom(snaps: (Dungeon | undefined)[]): Timeline {
  return {
    lastIndex: () => snaps.length - 1,
    readSnapshot: id => {
      const i = id === 'latest' ? snaps.length - 1 : id;
      return i < 0 ? undefined : snaps[i];
    },
    writeSnapshot: (i, dungeon) => {
      snaps[i] = dungeon;
    },
  };
}

describe('baselineBefore', () => {
  it('returns the nearest preceding snapshot', () => {
    const tl = tlFrom([d(10), undefined, d(6)]);
    expect(baselineBefore(tl, 2)?.player.hp.cur).toBe(10); // index 1 is a gap → index 0
  });

  it('skips user-message gaps (undefined) to the nearest snapshot', () => {
    const tl = tlFrom([d(8), undefined, undefined, d(3)]);
    expect(baselineBefore(tl, 3)?.player.hp.cur).toBe(8);
  });

  it('returns undefined when no preceding snapshot exists (first turn)', () => {
    expect(baselineBefore(tlFrom([undefined, undefined]), 1)).toBeUndefined();
    expect(baselineBefore(tlFrom([]), 0)).toBeUndefined();
  });
});
