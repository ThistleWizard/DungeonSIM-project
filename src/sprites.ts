/**
 * sprites.ts — the PURE sprite resolver (M7, design §15). No SillyTavern, no DOM in the core
 * (the one DOM helper, `fillSprites`, self-guards) → fully unit-testable, same split as
 * map/sheet/display.
 *
 * Division of labour (the project's signature move, a sixth time): the model decides WHAT a
 * creature looks like by emitting controlled-vocab `tags` on the bestiary TYPE; the script
 * decides WHICH concrete sprite by scoring those tags against a pack and LOCKING the choice per
 * mob INSTANCE. The model never sees the catalog (no token cost); resolution is deterministic
 * (so it's testable and rewind-stable).
 *
 * Resolution ladder (per the spec): scored pack match → category-generic silhouette by primary
 * tag → null (the viewport then shows its text placeholder; the gen fallback, deferred, would
 * slot between the last two). Among equally-scoring pack candidates, `hashId(mob.id)` ties-break
 * so two same-type mobs can differ yet each stays stable across turns + rewind.
 */
import _ from 'lodash';
import type { Dungeon } from './schema.js';
import { ARCHETYPES, type SpriteEntry, type SpritePack } from './pack.js';

const ARCHETYPE_SET: ReadonlySet<string> = new Set(ARCHETYPES);
/** Archetype (body-plan) tags dominate; descriptors only refine within a body plan. */
const ARCHETYPE_WEIGHT = 10;
const DESCRIPTOR_WEIGHT = 1;

/**
 * Deterministic 32-bit FNV-1a string hash (unsigned). Pack-free, stable across runs/platforms —
 * the tie-break that gives per-instance variety without storing a seed.
 */
export function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Weighted overlap of a mob's tags against one pack sprite. Archetype matches are worth far more
 * than descriptor matches, so a sprite sharing the body plan always beats one that only shares a
 * descriptor. Unknown/free tags simply don't intersect → contribute 0 (never break matching).
 */
export function scoreSprite(tags: string[], sprite: SpriteEntry): number {
  const want = new Set(tags);
  let score = 0;
  for (const t of new Set(sprite.tags)) {
    if (want.has(t)) score += ARCHETYPE_SET.has(t) ? ARCHETYPE_WEIGHT : DESCRIPTOR_WEIGHT;
  }
  return score;
}

/**
 * Choose a sprite ref for one mob: score the type's tags across the pack, pick deterministically
 * among the top scorers by `hashId(mob.id)`, else fall back to the category-generic for the
 * primary (first) tag, else null. Returns a scheme-prefixed ref (`pack:<id>`) or null.
 */
export function resolveMobSprite(
  mob: { id?: string; type?: string },
  bestiary: Dungeon['bestiary'] | undefined,
  pack: SpritePack,
): string | null {
  const tags = (mob.type && bestiary?.[mob.type]?.tags) || [];
  const id = mob.id ?? '';

  if (pack.sprites.length && tags.length) {
    let best = 0;
    const candidates: SpriteEntry[] = [];
    for (const sprite of pack.sprites) {
      const s = scoreSprite(tags, sprite);
      if (s > best) {
        best = s;
        candidates.length = 0;
        candidates.push(sprite);
      } else if (s === best && s > 0) {
        candidates.push(sprite);
      }
    }
    if (candidates.length) {
      const chosen = candidates[hashId(id) % candidates.length];
      return `pack:${chosen.id}`;
    }
  }

  // No tag overlap → category-generic silhouette by primary archetype tag.
  const primary = tags[0];
  const genericId = primary ? pack.categoryGenerics?.[primary] : undefined;
  return genericId ? `pack:${genericId}` : null;
}

/**
 * Lock sprites onto every combat mob that lacks one. PURE: deep-clones, mutates the clone,
 * returns it. Idempotent — a mob whose `sprite` is already set is left alone, so re-running
 * (and re-applying through a rewind snapshot) never changes a locked choice.
 */
export function resolveSprites(dungeon: Dungeon, pack: SpritePack): Dungeon {
  const mobs = dungeon.combat?.mobs;
  if (!Array.isArray(mobs) || mobs.length === 0) return dungeon;
  if (!mobs.some(m => m && m.sprite == null)) return dungeon; // nothing to resolve

  const d = _.cloneDeep(dungeon);
  for (const mob of d.combat.mobs) {
    if (mob && mob.sprite == null) {
      mob.sprite = resolveMobSprite(mob, d.bestiary, pack);
    }
  }
  return d;
}

/** Resolve a stored ref to a concrete image source from the pack. `gen:` is deferred → null. */
export function spriteRefToSrc(ref: string | null | undefined, pack: SpritePack): string | null {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('pack:')) {
    const id = ref.slice(5);
    return pack.sprites.find(s => s.id === id)?.src ?? null;
  }
  return null; // 'gen:<type>' handled by the (deferred) gen fallback
}

// ---------- DOM filler (SillyTavern only; self-guards) ----------

/**
 * Fill every `[data-sprite-ref]` slot under `root` with its pack image. The PURE renderer emits
 * the slot + ref (from locked state); this impure step turns the ref into bytes — so renderers
 * never depend on the pack and stay testable. Called after each panel render (rides onRefresh /
 * rewind for free). No-ops without a DOM, so importing this in Vitest is harmless.
 */
export function fillSprites(
  root: { querySelectorAll?: (sel: string) => ArrayLike<Element> } | null,
  pack: SpritePack,
): void {
  const slots = root?.querySelectorAll?.('[data-sprite-ref]');
  if (!slots) return;
  for (let i = 0; i < slots.length; i++) {
    const el = slots[i] as HTMLElement;
    const ref = el.getAttribute?.('data-sprite-ref') ?? '';
    const src = spriteRefToSrc(ref, pack);
    if (!src) continue; // no ref / unresolved → leave the existing placeholder
    el.innerHTML =
      `<img src="${src}" alt="" style="width:88px;height:88px;image-rendering:pixelated;` +
      `object-fit:contain;display:block">`;
  }
}
