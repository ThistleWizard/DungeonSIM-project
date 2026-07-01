/**
 * style.test.ts — the shared Gold Box chrome. Small on purpose: the renderers that use it
 * have their own tests; what's guarded here is the one way panel() has actually broken.
 */
import { describe, expect, it } from 'vitest';
import { FONT_FAMILY, panel } from '../src/style.js';

describe('panel chrome', () => {
  // Regression: the restyle shipped FONT_FAMILY as `"Silkscreen", monospace` — and a double
  // quote interpolated into an inline `style="…"` attribute TERMINATES the attribute,
  // silently stripping every declaration after it. Every panel() frame lost its background,
  // border, display:flex and overflow:hidden (found by the M9 mockup screenshot; invisible
  // in ST until the restyle was live-checked). Font names in inline styles must be
  // single-quoted.
  it('FONT_FAMILY contains no double quotes (inline style attribute safety)', () => {
    expect(FONT_FAMILY).not.toContain('"');
  });

  it('the frame style attribute survives intact from font-family through overflow:hidden', () => {
    expect(panel('Test', 'body')).toMatch(/style="[^"]*font-family:[^"]*overflow:hidden[^"]*"/);
  });

  it('escapes the title', () => {
    expect(panel('<x>', 'body')).toContain('— &lt;x&gt; —');
  });
});
