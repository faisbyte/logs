// Near-duplicate removal for merged lists (DECISIONS.md D38): Dice similarity over content words.

const FILLER = new Set(
  'a an the and or of to in on for is are was were be been it its this that with as at by from not no so but if then than into still also needs need must should'.split(' '),
);
const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !FILLER.has(w)));

/** 0 to 1: how many content words two texts share (Dice coefficient), ignoring case, punctuation and filler words. */
export function similarity(a: string, b: string): number {
  const [x, y] = [words(a), words(b)];
  if (x.size + y.size === 0) return 1;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

export const NEAR_DUPLICATE = 0.5;

/** Collapses each group of near-duplicates to its longest item, kept at the group's first position. */
export function dropNearDuplicates(items: readonly string[], threshold = NEAR_DUPLICATE): string[] {
  const kept: string[] = [];
  for (const item of items) {
    const i = kept.findIndex((k) => similarity(k, item) > threshold);
    if (i === -1) kept.push(item);
    else if (item.length > kept[i]!.length) kept[i] = item;
  }
  return kept;
}
