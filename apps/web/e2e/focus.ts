import type { Page } from '@playwright/test';
import { composite, contrastRatio, type Rgb, type Rgba } from '../test/contrast';

// axe doesn't check focus indicators, so this does (WCAG 2.2 1.4.11 / 2.4.13 ask 3:1 against what the ring is drawn on).
// It tabs through the page and, at each stop, reads the ring's colour and every background layer under it, in the browser.

export type Ring = { stop: string; width: number; ratio: number };

type Sample = { stop: string; width: number; ring: Rgba; layers: Rgba[] } | null;

function sample(): Sample {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Any CSS colour (oklch, color-mix, named) to sRGB, the way the browser paints it.
  const rgba = (css: string): Rgba => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  // A row link draws its ring on the row (see .row-link in globals.css).
  let ringEl: HTMLElement | null = el;
  while (ringEl && (getComputedStyle(ringEl).outlineStyle === 'none' || parseFloat(getComputedStyle(ringEl).outlineWidth) === 0)) ringEl = ringEl.parentElement;
  const label = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
  if (!ringEl) return { stop: label, width: 0, ring: [0, 0, 0, 0], layers: [] };
  const style = getComputedStyle(ringEl);
  // An inset ring (negative offset) sits on its own element's background; an outset one on its parent's.
  const layers: Rgba[] = [];
  for (let at: HTMLElement | null = parseFloat(style.outlineOffset) < 0 ? ringEl : ringEl.parentElement; at; at = at.parentElement) layers.push(rgba(getComputedStyle(at).backgroundColor));
  return { stop: label, width: parseFloat(style.outlineWidth), ring: rgba(style.outlineColor), layers };
}

const flatten = (layers: Rgba[]): Rgb => layers.reduceRight<Rgb>((under, layer) => composite(layer, under), [255, 255, 255]);

/** Every tab stop on the page, in order, with its ring width and contrast. */
export async function focusRings(page: Page, max = 80): Promise<Ring[]> {
  await page.locator('body').focus();
  const rings: Ring[] = [];
  let first: string | null = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(sample);
    if (!s) break;
    const id = await page.evaluate(() => {
      const el = document.activeElement!;
      return `${el.tagName}#${el.id}|${el.textContent?.slice(0, 60)}|${Array.prototype.indexOf.call(document.querySelectorAll('*'), el)}`;
    });
    if (id === first) break;
    first ??= id;
    const under = flatten(s.layers);
    rings.push({ stop: s.stop, width: s.width, ratio: contrastRatio(flatten([s.ring, ...s.layers]), under) });
  }
  return rings;
}
