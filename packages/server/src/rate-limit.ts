// Rate limiting (DECISIONS.md D101): each caller gets a number of requests per one-minute window, counted in memory
// (one server process). A caller is the hash of its token or session, or its address when it sends neither.

const WINDOW_MS = 60_000;

export type Take = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  #swept: number;

  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#swept = now();
  }

  /** Counts one request for the caller, unless it is over its limit for this window. */
  take(key: string): Take {
    const now = this.now();
    // Callers whose window has ended are forgotten once a minute, so memory follows recent callers only.
    if (now - this.#swept >= WINDOW_MS) {
      for (const [k, w] of this.#windows) if (now - w.start >= WINDOW_MS) this.#windows.delete(k);
      this.#swept = now;
    }
    const window = this.#windows.get(key);
    if (!window || now - window.start >= WINDOW_MS) {
      this.#windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (window.count >= this.perMinute) return { ok: false, retryAfterSeconds: Math.ceil((window.start + WINDOW_MS - now) / 1000) };
    window.count++;
    return { ok: true };
  }

  /** How many callers are being counted. */
  get size(): number {
    return this.#windows.size;
  }
}

/** Requests a minute per caller from RATE_LIMIT_PER_MINUTE: 300 by default, null when 0 turns it off. */
export function rateLimitFromEnv(env: Record<string, string | undefined>): number | null {
  const value = env.RATE_LIMIT_PER_MINUTE;
  if (value === undefined || value === '') return 300;
  if (!/^\d+$/.test(value)) throw new Error('RATE_LIMIT_PER_MINUTE must be a whole number of requests a minute, or 0 to turn it off.');
  return Number(value) || null;
}
