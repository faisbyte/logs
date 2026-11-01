// Client for the shared key-value store. Values are JSON; a ttl is in seconds.

export function createKv(transport) {
  return {
    async get(key) {
      const raw = await transport.get(key);
      return raw === null ? null : JSON.parse(raw);
    },
    async set(key, value, { ttlSeconds } = {}) {
      await transport.set(key, JSON.stringify(value), ttlSeconds);
    },
    async delete(key) {
      await transport.delete(key);
    },
  };
}

/** A transport kept in memory, for tests and local runs. */
export function memoryTransport({ now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return entry.raw;
    },
    async set(key, raw, ttlSeconds) {
      store.set(key, { raw, expiresAt: ttlSeconds ? now() + ttlSeconds * 1000 : null });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
