import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogin } from '../src/auth/login.js';
import { hashPassword } from '../src/auth/password.js';
import { sessionUser } from '../src/auth/session.js';
import { createKv, memoryTransport } from '../src/lib/kv.js';
import { memoryUsers } from '../src/users/store.js';

const users = memoryUsers([{ id: 'u1', email: 'ana@example.com', name: 'Ana', passwordHash: hashPassword('right horse') }]);

test('logs in with the right password and starts a session', async () => {
  const kv = createKv(memoryTransport());
  const result = await createLogin({ users, kv })('Ana@Example.com ', 'right horse');
  assert.equal(result.ok, true);
  assert.equal(await sessionUser(kv, result.token), 'u1');
});

test('refuses a wrong password or an unknown email', async () => {
  const login = createLogin({ users, kv: createKv(memoryTransport()) });
  assert.deepEqual(await login('ana@example.com', 'wrong'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await login('nobody@example.com', 'right horse'), { ok: false, reason: 'invalid' });
});
