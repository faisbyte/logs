import { verifyPassword } from './password.js';
import { createSession } from './session.js';

export function createLogin({ users, kv, clock = () => Date.now() }) {
  return async function login(email, password) {
    const user = await users.findByEmail(email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.passwordHash)) return { ok: false, reason: 'invalid' };
    const token = await createSession(kv, user.id);
    return { ok: true, userId: user.id, token };
  };
}
