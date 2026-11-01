import { cache } from '../lib/cache.js';

const PROFILE_TTL_MS = 60_000;

export function createProfiles({ users, clock = () => Date.now() }) {
  return async function profile(userId) {
    const cached = cache.get(`profile:${userId}`, clock());
    if (cached) return cached;
    const user = await users.findById(userId);
    if (!user) return null;
    const result = { id: user.id, name: user.name };
    cache.set(`profile:${userId}`, result, PROFILE_TTL_MS, clock());
    return result;
  };
}
