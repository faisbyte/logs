// A small in-process cache with expiry, used to keep hot reads off the database.

const entries = new Map();

const live = (key, now) => {
  const entry = entries.get(key);
  if (entry && entry.expiresAt <= now) entries.delete(key);
  return entries.get(key);
};

export const cache = {
  get(key, now = Date.now()) {
    return live(key, now)?.value;
  },
  set(key, value, ttlMs, now = Date.now()) {
    entries.set(key, { value, expiresAt: now + ttlMs });
  },
  /** Adds one to a counter and returns it; the expiry starts with the first increment. */
  increment(key, ttlMs, now = Date.now()) {
    const entry = live(key, now);
    if (!entry) {
      entries.set(key, { value: 1, expiresAt: now + ttlMs });
      return 1;
    }
    entry.value += 1;
    return entry.value;
  },
  delete(key) {
    entries.delete(key);
  },
  clear() {
    entries.clear();
  },
};
