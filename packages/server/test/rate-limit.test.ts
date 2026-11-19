import { describe, expect, it } from 'vitest';
import { RateLimiter, rateLimitFromEnv } from '../src/rate-limit.js';

// Rate limiting (DECISIONS.md D101): a fixed one-minute window per caller.

describe('RateLimiter', () => {
  it('allows the limit in a minute, then refuses with the seconds left until the window ends', () => {
    let now = Date.parse('2026-11-19T10:00:00.000Z');
    const limiter = new RateLimiter(3, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    now += 20_500;
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 40 });
    expect(limiter.take('b')).toEqual({ ok: true });
    now += 39_500;
    expect(limiter.take('a')).toEqual({ ok: true });
  });

  it('forgets callers whose window has ended, so memory stays bounded', () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now);
    for (let i = 0; i < 100; i++) limiter.take(`caller-${i}`);
    expect(limiter.size).toBe(100);
    now += 60_000;
    limiter.take('late');
    expect(limiter.size).toBe(1);
  });
});

describe('rateLimitFromEnv', () => {
  it('defaults to 300 a minute, turns off with 0, and refuses nonsense', () => {
    expect(rateLimitFromEnv({})).toBe(300);
    expect(rateLimitFromEnv({ RATE_LIMIT_PER_MINUTE: '60' })).toBe(60);
    expect(rateLimitFromEnv({ RATE_LIMIT_PER_MINUTE: '0' })).toBeNull();
    expect(() => rateLimitFromEnv({ RATE_LIMIT_PER_MINUTE: 'lots' })).toThrow('RATE_LIMIT_PER_MINUTE must be a whole number of requests a minute, or 0 to turn it off.');
  });
});
