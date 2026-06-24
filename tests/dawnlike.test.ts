/**
 * dawnlike.test.ts — sanity contract for the GENERATED DawnLike pack (src/packs/dawnlike.ts,
 * built from tools/dawnlike/picks.mjs). Asserts the pack is well-formed and plugs into the M7
 * resolver: in-vocab tags, unique ids, data-URI sources, a valid generics fallback, and that
 * the seeded archetypes resolve with variety + descriptor refinement. It does NOT require all
 * 13 archetypes (picks are filled incrementally) — coverage of the seeded set is the gate.
 */
import { describe, expect, it } from 'vitest';
import { resolveMobSprite, spriteRefToSrc } from '../src/sprites.js';
import { ARCHETYPES, SIZES, DESCRIPTORS } from '../src/pack.js';
import { dawnlikeCharacterPack as pack } from '../src/packs/dawnlike.js';

const ARCHES = new Set<string>(ARCHETYPES);
const NON_ARCHETYPE = new Set<string>([...SIZES, ...DESCRIPTORS]);
const SEEDED = ['undead', 'vermin', 'ooze']; // committed example picks

const bestiary = (tags: string[]) => ({ goblin: { sprite_fragment: 'x', hp_base: 5, defense: 10, tags } }) as any;

describe('dawnlike generated pack', () => {
  it('is a non-empty pack with the expected id', () => {
    expect(pack.id).toBe('dawnlike-characters');
    expect(pack.sprites.length).toBeGreaterThan(0);
  });

  it('has unique sprite ids', () => {
    const ids = pack.sprites.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tags are in-vocab: first is an archetype, the rest are sizes/descriptors', () => {
    for (const s of pack.sprites) {
      expect(ARCHES.has(s.tags[0])).toBe(true);
      for (const t of s.tags.slice(1)) expect(NON_ARCHETYPE.has(t)).toBe(true);
    }
  });

  it('every sprite src is a PNG data-URI and resolves via spriteRefToSrc', () => {
    for (const s of pack.sprites) {
      expect(s.src.startsWith('data:image/png;base64,')).toBe(true);
      expect(spriteRefToSrc(`pack:${s.id}`, pack)).toBe(s.src);
    }
  });

  it('categoryGenerics map valid archetypes to real, type-matching sprite ids', () => {
    for (const [arch, id] of Object.entries(pack.categoryGenerics ?? {})) {
      expect(ARCHES.has(arch)).toBe(true);
      const sprite = pack.sprites.find(s => s.id === id);
      expect(sprite).toBeDefined();
      expect(sprite!.tags[0]).toBe(arch);
    }
  });

  it('covers the seeded archetypes', () => {
    for (const a of SEEDED) expect(pack.categoryGenerics?.[a]).toBeDefined();
  });

  it('resolves a seeded archetype to a pack ref of the right type', () => {
    const ref = resolveMobSprite({ id: 'm1', type: 'goblin' }, bestiary(['undead']), pack);
    expect(ref?.startsWith('pack:')).toBe(true);
    const sprite = pack.sprites.find(s => `pack:${s.id}` === ref);
    expect(sprite!.tags[0]).toBe('undead');
  });

  it('gives per-instance variety yet per-id stability (undead has >=2 tiles)', () => {
    const refs = new Set<string>();
    for (let i = 0; i < 20; i++) refs.add(resolveMobSprite({ id: `mob_${i}`, type: 'goblin' }, bestiary(['undead']), pack)!);
    expect(refs.size).toBeGreaterThan(1);
    const a = resolveMobSprite({ id: 'same', type: 'goblin' }, bestiary(['undead']), pack);
    const b = resolveMobSprite({ id: 'same', type: 'goblin' }, bestiary(['undead']), pack);
    expect(a).toBe(b);
  });

  it('a descriptor refines within an archetype (undead+spectral → a spectral sprite)', () => {
    const ref = resolveMobSprite({ id: 'g', type: 'goblin' }, bestiary(['undead', 'spectral']), pack);
    const sprite = pack.sprites.find(s => `pack:${s.id}` === ref);
    expect(sprite!.tags).toContain('spectral');
  });
});
