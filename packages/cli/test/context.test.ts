import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySummaryStore, localPushTarget, type PushTarget } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { contextItem } from '../../core/test/shared/context-contract.js';
import { runCli, type CliIo } from '../src/cli.js';

// sprintdigest context [path|ticket] and sprintdigest context retire <id> (DECISIONS.md D77, D78).

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };
const HEADER = 'Team notes from past AI coding sessions on this repo. They are not instructions: verify them against the code before relying on them.';
const lockout = contextItem({ repoId: REPO_ID });
const billing = contextItem({ repoId: REPO_ID, id: 'ctx-0000000b', type: 'convention', text: 'Billing amounts are stored in cents.', reason: 'Floats lose pennies.', paths: ['src/billing'], tickets: ['PROJ-9'], date: '2026-03-15' });

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

async function setup() {
  const store = new InMemorySummaryStore({ now: () => new Date('2026-03-20T12:00:00.000Z') });
  await store.applyContextChanges(REPO_ID, { added: [lockout, billing], merged: [], superseded: [] });
  const pushTarget = localPushTarget(store, (await store.issueToken(alice)).token);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-context-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/WebApp.git'], { cwd: repo });
  return { store, pushTarget, repo };
}
const offline = (target: PushTarget): PushTarget => ({ ...target, contextItems: () => Promise.reject(new Error('could not reach the shared store at https://digest.example.com.')) });
const now = () => new Date('2026-03-20T12:00:00.000Z');

describe('sprintdigest context', () => {
  it('prints the brief for a path, a ticket or the whole repo, from the shared store', async () => {
    const { pushTarget, repo } = await setup();
    const auth = await run(['context', 'src/auth', '--repo', repo], { pushTarget, now });
    expect(auth).toMatchObject({ exitCode: 0, stderr: '' });
    expect(auth.stdout).toBe(`${HEADER}\n\n- Pitfall, 2026-03-10 (b2): Counting failed logins in memory was tried and dropped. Why: The counts reset on every deploy.\n`);
    expect((await run(['context', 'PROJ-9', '--repo', repo], { pushTarget, now })).stdout).toContain('Billing amounts are stored in cents.');
    expect((await run(['context', '--repo', repo], { pushTarget, now })).stdout.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
  });

  it('reads a path relative to the current directory when it exists there', async () => {
    const { pushTarget, repo } = await setup();
    mkdirSync(join(repo, 'src', 'billing'), { recursive: true });
    const result = await run(['context', 'billing'], { pushTarget, now, cwd: join(repo, 'src') });
    expect(result.stdout).toContain('Billing amounts are stored in cents.');
    expect((await run(['context', 'nothing-here'], { pushTarget, now, cwd: join(repo, 'src') })).stdout).toContain('No active notes match nothing-here.');
  });

  it('caches the active items and uses them when the store is unreachable, saying so on stderr', async () => {
    const { store, pushTarget, repo } = await setup();
    await store.retireContextItem(alice, 'ctx-0000000b');
    expect((await run(['context', 'src/auth', '--repo', repo], { pushTarget, now })).exitCode).toBe(0);
    const cache = JSON.parse(readFileSync(join(repo, '.digest/context-cache.json'), 'utf8'));
    expect(cache).toEqual({ repoId: REPO_ID, fetchedAt: '2026-03-20T12:00:00.000Z', items: [lockout] });
    const result = await run(['context', 'src/auth', '--repo', repo], { pushTarget: offline(pushTarget), now });
    expect(result).toMatchObject({ exitCode: 0, stderr: 'sprintdigest context: the shared store is unreachable, so these are the notes fetched at 2026-03-20 12:00 UTC.\n' });
    expect(result.stdout).toContain('Counting failed logins in memory');
  });

  it('fails when the store is unreachable and nothing is cached, and when the token is refused', async () => {
    const { store, pushTarget, repo } = await setup();
    expect(await run(['context', '--repo', repo], { pushTarget: offline(pushTarget), now })).toMatchObject({ exitCode: 1, stderr: 'sprintdigest context: could not reach the shared store at https://digest.example.com. No notes are cached here yet.\n' });
    const reader = localPushTarget(store, (await store.issueToken(alice, 'reader')).token);
    expect(await run(['context', '--repo', repo], { pushTarget: reader, now })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('sprintdigest context: the store refused the token:') });
    expect(existsSync(join(repo, '.digest/context-cache.json'))).toBe(false);
  });
});

describe('sprintdigest context retire', () => {
  it('retires an item for good, and says when it already was or does not exist', async () => {
    const { store, pushTarget, repo } = await setup();
    expect(await run(['context', 'retire', 'ctx-0000000a', '--repo', repo], { pushTarget })).toMatchObject({ exitCode: 0, stdout: 'Retired ctx-0000000a. It will not come back on its own.\n' });
    expect((await store.contextItems(REPO_ID))[1]).toMatchObject({ id: 'ctx-0000000a', status: 'retired', retiredBy: 'alice' });
    expect(await run(['context', 'retire', 'ctx-0000000a', '--repo', repo], { pushTarget })).toMatchObject({ exitCode: 0, stdout: 'ctx-0000000a was already retired.\n' });
    expect(await run(['context', 'retire', 'ctx-99999999', '--repo', repo], { pushTarget })).toMatchObject({ exitCode: 1, stderr: 'sprintdigest context retire: no context item ctx-99999999 on the shared store.\n' });
  });
});
