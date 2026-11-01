import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { cache } from '../src/lib/cache.js';
import { createProfiles } from '../src/users/profile.js';
import { memoryUsers } from '../src/users/store.js';

beforeEach(() => cache.clear());

test('reads a profile once, then from the cache', async () => {
  let reads = 0;
  const users = memoryUsers([{ id: 'u1', email: 'ana@example.com', name: 'Ana', passwordHash: 'x:y' }]);
  const counting = { ...users, findById: async (id) => (reads++, users.findById(id)) };
  const profile = createProfiles({ users: counting });
  assert.deepEqual(await profile('u1'), { id: 'u1', name: 'Ana' });
  assert.deepEqual(await profile('u1'), { id: 'u1', name: 'Ana' });
  assert.equal(reads, 1);
});
