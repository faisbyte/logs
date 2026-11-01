import { createLogin } from './auth/login.js';
import { createProfiles } from './users/profile.js';

export function createApp({ users, kv, clock = () => Date.now() }) {
  return { login: createLogin({ users, kv, clock }), profile: createProfiles({ users, clock }) };
}
