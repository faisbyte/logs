import { describe, expect, it } from 'vitest';
import { dropNearDuplicates, similarity } from '../../src/summarize/dedupe.js';

// Shapes calibrated on the v7 real-session run (DECISIONS.md D38): near-duplicates scored 0.57-0.59,
// the closest distinct pair 0.33. The text here is synthetic.
const rerun = 'Re-run the notebook to confirm the load step now works after the region column fix.';
const rerunLater = 'Re-run the notebook to confirm the load step works locally and the remaining charts render correctly.';
const verify = 'Verify the remaining charts render correctly once the data loads.';

describe('similarity', () => {
  it('ignores case, punctuation and filler words', () => {
    expect(similarity('Fix the flaky date test!', 'fix flaky date test')).toBe(1);
  });

  it('scores rewordings of one item above 0.5 and related but distinct items below it', () => {
    expect(similarity(rerun, rerunLater)).toBeGreaterThan(0.5);
    expect(similarity(verify, rerunLater)).toBeLessThan(0.5);
  });
});

describe('dropNearDuplicates', () => {
  it('keeps distinct items in order', () => {
    expect(dropNearDuplicates([verify, 'Commit the migration.', 'Add a test for the empty state.'])).toEqual([verify, 'Commit the migration.', 'Add a test for the empty state.']);
  });

  it('keeps the longer of two near-duplicates, in the earlier position', () => {
    expect(dropNearDuplicates([rerun, verify, rerunLater])).toEqual([rerunLater, verify]);
  });

  it('collapses a whole group of near-duplicates to one', () => {
    const gating = ['Fix the hook gating: negated mentions disable demotion.', 'Fix the hook gating before measuring: negated mentions such as "not the tests" disable demotion.', 'Hook gating: negated mentions disable demotion.'];
    expect(dropNearDuplicates(gating)).toEqual([gating[1]]);
  });
});
