// WCAG 2.x contrast, shared by the unit test and the end-to-end focus-ring check (e2e/focus.ts).

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A translucent colour flattened over an opaque one. */
export const composite = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgb): Rgb => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
