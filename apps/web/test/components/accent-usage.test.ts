// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Each accent means one thing (docs/dashboard-design.md): green approved or safe, amber pitfall, warning or needs
// attention, blue decision, violet convention. This scans the source so a colour can't drift into another meaning:
// components reach accents only through a tone (pills, markers, callouts) or, for amber, an alert.

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
const lines = (ext: RegExp) => files(SRC).filter((f) => ext.test(f)).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((text, i) => ({ at: `${relative(SRC, f)}:${i + 1}`, text })));

/** CSS rules (selector and body) that use a colour token, outside the token definitions themselves. */
function cssRulesUsing(token: string) {
  const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => new RegExp(`var\\(--${token}\\)`).test(body!))
    .map(([, selector]) => selector!.trim().replace(/\s+/g, ' '))
    // @theme only maps tokens to utility names; the component scan above catches any use of those utilities.
    .filter((selector) => !selector.startsWith('@theme'))
    .sort();
}

describe('accent colours carry one meaning each', () => {
  it('components never set an accent colour directly, except amber on an alert', () => {
    const misused = lines(/\.tsx?$/)
      .filter(({ text }) => /\b(text|bg|border|outline|decoration|fill|stroke)-(accent|blue|violet|amber)\b/.test(text))
      .filter(({ text }) => !(/\btext-amber\b/.test(text) && /role="alert"/.test(text)));
    expect(misused.map((l) => `${l.at}: ${l.text.trim()}`)).toEqual([]);
  });

  it('the stylesheet uses green only for safe, and the other accents only for their own meaning', () => {
    expect(cssRulesUsing('accent')).toEqual(['.pill[data-tone="safe"]']);
    expect(cssRulesUsing('amber')).toEqual(['.callout-attention', '.marker[data-marker="attention"]', '.pill[data-tone="attention"]']);
    expect(cssRulesUsing('blue')).toEqual(['.marker[data-marker="decision"]', '.pill[data-tone="decision"]']);
    expect(cssRulesUsing('violet')).toEqual(['.pill[data-tone="convention"]']);
  });
});
