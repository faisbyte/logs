import { randomBytes } from 'node:crypto';

const DAY_SECONDS = 24 * 60 * 60;

export async function createSession(kv, userId) {
  const token = randomBytes(32).toString('hex');
  await kv.set(`session:${token}`, { userId }, { ttlSeconds: DAY_SECONDS });
  return token;
}

export async function sessionUser(kv, token) {
  return (await kv.get(`session:${token}`))?.userId ?? null;
}
