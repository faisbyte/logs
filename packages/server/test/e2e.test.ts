import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, reject, saveSummary } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../cli/src/cli.js';
import { draftSummary } from '../../core/test/review/helpers.js';
import { openStore, serverCli, startServer } from '../src/cli.js';

// Phase 5 "Done when": two developer identities push summaries for the same repo, and both appear in one
// combined list. Everything runs locally: a real HTTP server on a PGlite database, and the digest CLI.

const base = realpathSync(mkdtempSync(join(tmpdir(), 'digest-e2e-')));
const dataDir = join(base, 'server-db');

async function issueToken(developer: string, name: string, repo: string) {
  let out = '';
  expect(await serverCli(['token', '--data', dataDir, '--repo', repo, '--developer', developer, '--name', name], { stdout: (s) => (out += s), stderr: () => {}, env: {} })).toBe(0);
  return /^(dgt_\S+)$/m.exec(out)![1]!;
}

function developerRepo(name: string, remote: string, serverUrl: string, token: string, sessions: { id: string; goal: string }[]) {
  const repo = join(base, name);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  mkdirSync(join(repo, '.digest'));
  writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ share: { url: serverUrl } }));
  writeFileSync(join(repo, '.digest/token'), `${token}\n`);
  for (const s of sessions) saveSummary(repo, approve(draftSummary({ sessionId: s.id, goal: s.goal })).summary as ReturnType<typeof draftSummary>);
  saveSummary(repo, draftSummary({ sessionId: `${name}-draft`, goal: `${name}: not reviewed yet.` }));
  saveSummary(repo, reject(draftSummary({ sessionId: `${name}-rejected`, goal: `${name}: rejected.` })));
  return repo;
}

async function digest(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', env: {} });
  return { exitCode, stdout, stderr };
}

describe('Phase 5 end to end', () => {
  it('two developers push to one repo and both appear in the combined list', async () => {
    const aliceToken = await issueToken('alice', 'Alice', 'git@github.com:Acme/WebApp.git');
    const bobToken = await issueToken('bob', 'Bob', 'https://github.com/acme/webapp');
    const { store, close } = await openStore({ dataDir });
    const server = await startServer({ store, port: 0, log: () => {} });
    try {
      const alice = developerRepo('alice', 'git@github.com:Acme/WebApp.git', server.url, aliceToken, [
        { id: 'a0000001-0000-4000-8000-000000000001', goal: 'Rate limit the login endpoint.' },
        { id: 'a0000002-0000-4000-8000-000000000002', goal: 'Add audit logging to admin actions.' },
      ]);
      const bob = developerRepo('bob', 'https://github.com/acme/webapp.git', server.url, bobToken, [{ id: 'b0000001-0000-4000-8000-000000000001', goal: 'Speed up search.' }]);

      const alicePush = await digest(['push', '--repo', alice]);
      expect(alicePush.exitCode).toBe(0);
      expect(alicePush.stdout).toContain('Pushed 2 summaries to github.com/acme/webapp.');
      expect((await digest(['push', '--repo', bob])).stdout).toContain('Pushed 1 summary to github.com/acme/webapp.');
      expect((await digest(['push', '--repo', bob])).stdout).toContain('Nothing to push');

      const report = await fetch(`${server.url}/v1/team-report?repoId=github.com%2Facme%2Fwebapp&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`, {
        headers: { authorization: `Bearer ${bobToken}` },
      }).then((r) => r.json());
      expect(report).toMatchObject({ repoId: 'github.com/acme/webapp', summaryCount: 3, developerCount: 2 });
      expect(report.summaries.map((s: { developerName: string; summary: { goal: string } }) => `${s.developerName}: ${s.summary.goal}`).sort()).toEqual([
        'Alice: Add audit logging to admin actions.',
        'Alice: Rate limit the login endpoint.',
        'Bob: Speed up search.',
      ]);
      expect(JSON.stringify(report)).not.toMatch(/not reviewed yet|rejected\./);
    } finally {
      await server.close();
      await close();
    }
  }, 30_000);
});
