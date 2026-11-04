import { composite, contrastRatio } from '../contrast';

describe('contrast maths for the focus-ring check (WCAG 2.x relative luminance)', () => {
  it('gives the WCAG ratios for known pairs', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 2);
    expect(contrastRatio([255, 255, 255], [119, 119, 119])).toBeCloseTo(4.48, 2);
    expect(contrastRatio([10, 11, 10], [10, 11, 10])).toBe(1);
  });

  it('flattens a translucent colour over what is under it', () => {
    expect(composite([255, 255, 255, 0.5], [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
    expect(composite([10, 20, 30, 1], [200, 200, 200])).toEqual([10, 20, 30]);
    expect(composite([10, 20, 30, 0], [200, 200, 200])).toEqual([200, 200, 200]);
  });
});
