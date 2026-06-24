/**
 * sprites.test.ts — M7 pure sprite resolver. No SillyTavern. Covers the scoring/selection
 * ladder, per-instance variety + determinism, idempotency/purity of resolveSprites, the
 * ref→src lookup, the DOM filler (fake DOM), and rewind round-tripping through the schema.
 */
import { describe, expect, it } from 'vitest';
import { fillSprites, hashId, resolveMobSprite, resolveSprites, scoreSprite, spriteRefToSrc } from '../src/sprites.js';
import { DEFAULT_PACK, type SpritePack } from '../src/pack.js';
import { DungeonSchema, type Dungeon } from '../src/schema.js';

type MobSpec = { id: string; type: string; sprite?: string | null };

function dungeon(bestiary: Record<string, { tags?: string[] }>, mobs: MobSpec[]): Dungeon {
  return DungeonSchema.parse({
    combat: { active: true, mobs: mobs.map(m => ({ name: m.type, hp_cur: 5, hp_max: 5, ...m })) },
    bestiary: Object.fromEntries(
      Object.entries(bestiary).map(([k, v]) => [k, { sprite_fragment: `a ${k}`, hp_base: 5, defense: 10, ...v }]),
    ),
  });
}

describe('hashId', () => {
  it('is deterministic and varies by input', () => {
    expect(hashId('goblin_01')).toBe(hashId('goblin_01'));
    expect(hashId('goblin_01')).not.toBe(hashId('goblin_02'));
    expect(hashId('')).toBeTypeOf('number');
  });
});

describe('scoreSprite', () => {
  it('weights an archetype match far above a descriptor match', () => {
    const arch = scoreSprite(['undead'], { id: 'a', tags: ['undead'], src: '' });
    const desc = scoreSprite(['undead'], { id: 'b', tags: ['armored'], src: '' });
    const both = scoreSprite(['undead', 'armored'], { id: 'c', tags: ['undead', 'armored'], src: '' });
    expect(desc).toBe(0); // no shared tag
    expect(arch).toBeGreaterThan(0);
    expect(both).toBeGreaterThan(arch); // descriptor refines on top of archetype
  });

  it('ignores unknown/free tags (no intersection → 0 contribution)', () => {
    expect(scoreSprite(['humanoid', 'sparkly'], { id: 'x', tags: ['humanoid'], src: '' })).toBe(
      scoreSprite(['humanoid'], { id: 'x', tags: ['humanoid'], src: '' }),
    );
  });
});

describe('resolveMobSprite (default pack)', () => {
  it('matches by archetype', () => {
    const d = dungeon({ skeleton: { tags: ['undead', 'skeletal'] } }, [{ id: 'skeleton_01', type: 'skeleton' }]);
    const ref = resolveMobSprite(d.combat.mobs[0], d.bestiary, DEFAULT_PACK);
    expect(ref).toMatch(/^pack:undead_skeletal_/); // the descriptor pair wins over plain undead
  });

  it('lets a descriptor shift the pick', () => {
    const d = dungeon({ guard: { tags: ['humanoid', 'armored'] } }, [{ id: 'guard_01', type: 'guard' }]);
    const ref = resolveMobSprite(d.combat.mobs[0], d.bestiary, DEFAULT_PACK);
    expect(ref).toMatch(/^pack:humanoid_armored_/);
  });

  it('gives per-instance variety yet is per-instance deterministic', () => {
    const refs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const d = dungeon({ goblin: { tags: ['humanoid'] } }, [{ id: `goblin_${i}`, type: 'goblin' }]);
      refs.add(resolveMobSprite(d.combat.mobs[0], d.bestiary, DEFAULT_PACK)!);
    }
    expect(refs.size).toBeGreaterThan(1); // different ids → different sprites (variety)
    // same id → same sprite (stable across turns/rewind)
    const a = dungeon({ goblin: { tags: ['humanoid'] } }, [{ id: 'goblin_3', type: 'goblin' }]);
    const b = dungeon({ goblin: { tags: ['humanoid'] } }, [{ id: 'goblin_3', type: 'goblin' }]);
    expect(resolveMobSprite(a.combat.mobs[0], a.bestiary, DEFAULT_PACK)).toBe(
      resolveMobSprite(b.combat.mobs[0], b.bestiary, DEFAULT_PACK),
    );
  });

  it('falls back to a category-generic when nothing scores, else null', () => {
    const fake: SpritePack = {
      id: 'f',
      name: 'f',
      sprites: [{ id: 'b1', tags: ['beast'], src: 'B' }],
      categoryGenerics: { humanoid: 'h_gen' },
    };
    const ghost = dungeon({ ghost: { tags: ['humanoid'] } }, [{ id: 'g1', type: 'ghost' }]);
    expect(resolveMobSprite(ghost.combat.mobs[0], ghost.bestiary, fake)).toBe('pack:h_gen');

    const weird = dungeon({ thing: { tags: ['sparkly'] } }, [{ id: 't1', type: 'thing' }]);
    expect(resolveMobSprite(weird.combat.mobs[0], weird.bestiary, fake)).toBeNull();

    const untyped = dungeon({}, [{ id: 'u1', type: 'missing' }]); // no bestiary entry → no tags
    expect(resolveMobSprite(untyped.combat.mobs[0], untyped.bestiary, fake)).toBeNull();
  });
});

describe('resolveSprites', () => {
  it('locks unresolved mobs, is idempotent, and never mutates its input', () => {
    const d = dungeon({ orc: { tags: ['humanoid'] } }, [
      { id: 'orc_1', type: 'orc' },
      { id: 'orc_2', type: 'orc', sprite: 'pack:humanoid_02' }, // already locked
    ]);
    const out = resolveSprites(d, DEFAULT_PACK);

    expect(d.combat.mobs[0].sprite).toBeNull(); // input untouched (purity)
    expect(out.combat.mobs[0].sprite).toMatch(/^pack:/); // unresolved → resolved
    expect(out.combat.mobs[1].sprite).toBe('pack:humanoid_02'); // locked mob left alone

    const again = resolveSprites(out, DEFAULT_PACK);
    expect(again).toBe(out); // nothing to do → returns same object reference
    expect(again.combat.mobs[0].sprite).toBe(out.combat.mobs[0].sprite);
  });

  it('no-ops with no combat mobs', () => {
    const d = DungeonSchema.parse({});
    expect(resolveSprites(d, DEFAULT_PACK)).toBe(d);
  });

  it('survives a rewind round-trip through the schema', () => {
    const d = dungeon({ wolf: { tags: ['beast'] } }, [{ id: 'wolf_1', type: 'wolf' }]);
    const out = resolveSprites(d, DEFAULT_PACK);
    const reparsed = DungeonSchema.parse(JSON.parse(JSON.stringify(out)));
    expect(reparsed.combat.mobs[0].sprite).toBe(out.combat.mobs[0].sprite);
  });
});

describe('spriteRefToSrc', () => {
  it('resolves a pack ref to its src; null/gen/unknown → null', () => {
    const id = DEFAULT_PACK.sprites[0].id;
    expect(spriteRefToSrc(`pack:${id}`, DEFAULT_PACK)).toBe(DEFAULT_PACK.sprites[0].src);
    expect(spriteRefToSrc('pack:does_not_exist', DEFAULT_PACK)).toBeNull();
    expect(spriteRefToSrc('gen:goblin', DEFAULT_PACK)).toBeNull();
    expect(spriteRefToSrc(null, DEFAULT_PACK)).toBeNull();
    expect(spriteRefToSrc(undefined, DEFAULT_PACK)).toBeNull();
  });
});

describe('fillSprites (fake DOM)', () => {
  function fakeSlot(ref: string) {
    return {
      _html: '',
      getAttribute: (n: string) => (n === 'data-sprite-ref' ? ref : null),
      set innerHTML(v: string) {
        this._html = v;
      },
      get innerHTML() {
        return this._html;
      },
    };
  }
  function fakeRoot(slots: any[]) {
    return { querySelectorAll: (_sel: string) => slots };
  }

  it('fills a resolved slot with an <img>, leaves unresolved/empty slots alone', () => {
    const id = DEFAULT_PACK.sprites[0].id;
    const good = fakeSlot(`pack:${id}`);
    const empty = fakeSlot('');
    const gen = fakeSlot('gen:goblin');
    fillSprites(fakeRoot([good, empty, gen]) as any, DEFAULT_PACK);
    expect(good.innerHTML).toContain('<img');
    expect(good.innerHTML).toContain(DEFAULT_PACK.sprites[0].src);
    expect(empty.innerHTML).toBe('');
    expect(gen.innerHTML).toBe('');
  });

  it('no-ops without a DOM', () => {
    expect(() => fillSprites(null, DEFAULT_PACK)).not.toThrow();
    expect(() => fillSprites({} as any, DEFAULT_PACK)).not.toThrow();
  });
});
