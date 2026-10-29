import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, FakeLlmClient, FakeTracker, refreshTracker, saveSummary, type TicketReport } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../cli/src/cli.js';
import { fixtureRepo, reply } from '../../cli/test/helpers.js';
import { draftSummary } from '../../core/test/review/helpers.js';
import { openStore, serverCli, startServer } from '../src/cli.js';

// Phase 6 "Done when": summaries are grouped correctly by ticket and sprint for a test project. Everything runs
// locally: digest-server on a PGlite database, the digest CLI for two developers, and a fake tracker.
//
// The project:
//   Sprint 1 is 2026-03-02 up to 2026-03-16, Sprint 2 is 2026-03-16 up to 2026-03-30.
//   Alice  c1a5e001  2026-03-02  summarised from a fixture session on feature/PROJ-142-rate-limit, with a commit
//                                "PROJ-150 ..." that also mentions SHA-256, UTF-8 and GPT-4 → PROJ-142 + PROJ-150
//          a2        2026-03-17  no ticket → unlinked, Sprint 2
//          a3        2026-03-20  no ticket when pushed; OPS-7 linked afterwards with digest link
//   Bob    b1        2026-03-15 22:00 to 03-16 02:00, PROJ-160 → crosses the boundary, lands in Sprint 1
//          b2        2026-03-18  PROJ-170, which the tracker knows and has in no sprint → No sprint
//          b3        2026-04-02  no ticket, after every sprint → No sprint, unlinked

const base = realpathSync(mkdtempSync(join(tmpdir(), 'digest-tickets-e2e-')));
const dataDir = join(base, 'server-db');
const REPO_ID = 'github.com/acme/webapp';
const id = (prefix: string) => `${prefix.padEnd(8, '0')}-0000-4000-8000-000000000000`;

async function admin(argv: string[]) {
  let out = '';
  expect(await serverCli([...argv, '--data', dataDir], { stdout: (s) => (out += s), stderr: (s) => (out += s), env: {} })).toBe(0);
  return out;
}
const token = async (developer: string, name: string) => /^(dgt_\S+)$/m.exec(await admin(['token', '--repo', REPO_ID, '--developer', developer, '--name', name]))![1]!;

async function digest(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

function share(repo: string, remote: string, url: string, tokenValue: string, config: object = {}) {
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  mkdirSync(join(repo, '.digest'), { recursive: true });
  writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ share: { url }, ...config }));
  writeFileSync(join(repo, '.digest/token'), `${tokenValue}\n`);
}

const approved = (repo: string, overrides: Parameters<typeof draftSummary>[0]) => saveSummary(repo, approve(draftSummary(overrides)).summary as ReturnType<typeof draftSummary>);
const at = (day: string, hour = '09') => `2026-${day}T${hour}:00:00.000Z`;

/** sprint → ticket → session id prefixes, plus unlinked. */
const shape = (report: TicketReport) =>
  Object.fromEntries(
    report.sprints.map((g) => [
      g.sprint?.name ?? '(no sprint)',
      {
        ...Object.fromEntries(g.tickets.map((t) => [t.key, t.summaries.map((e) => `${e.summary.developerName}:${e.summary.summary.sessionId.slice(0, 8)}:${e.link.source}`)])),
        ...(g.unlinked.length ? { unlinked: g.unlinked.map((s) => `${s.developerName}:${s.summary.sessionId.slice(0, 8)}`) } : {}),
      },
    ]),
  );

describe('Phase 6 end to end', () => {
  it('groups two developers’ summaries by sprint and ticket', async () => {
    // Admin setup, before the server holds the PGlite directory.
    const aliceToken = await token('alice', 'Alice');
    const bobToken = await token('bob', 'Bob');
    await admin(['sprint', '--repo', REPO_ID, '--name', 'Sprint 1', '--from', '2026-03-02', '--to', '2026-03-16']);
    await admin(['sprint', '--repo', REPO_ID, '--name', 'Sprint 2', '--from', '2026-03-16', '--to', '2026-03-30']);

    const { store, close } = await openStore({ dataDir });
    const server = await startServer({ store, port: 0, log: () => {} });
    try {
      // Alice: one session summarised from a fixture, with a noisy commit message, and project keys set.
      const { repo: alice, env } = fixtureRepo();
      const git = (args: string[]) => execFileSync('git', args, { cwd: alice, env: { ...process.env, GIT_AUTHOR_DATE: '2026-03-02T09:00:30Z', GIT_COMMITTER_DATE: '2026-03-02T09:00:30Z' } });
      git(['checkout', '-q', '-b', 'feature/PROJ-142-rate-limit']);
      git(['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'PROJ-150 limiter tests: hash keys with SHA-256, keep UTF-8 names, ask GPT-4 later']);
      share(alice, 'git@github.com:Acme/WebApp.git', server.url, aliceToken, { tickets: { keys: ['PROJ'] } });
      expect((await digest(['summarize', 'c1a5e001', '--repo', alice], { env, llm: new FakeLlmClient(reply, 'claude-haiku-5-5') })).exitCode).toBe(0);
      expect((await digest(['approve', 'c1a5e001', '--repo', alice], { env })).exitCode).toBe(0);
      approved(alice, { sessionId: id('a2'), goal: 'Tidy the audit log.', ticketRefs: [], branch: 'main', startedAt: at('03-17'), endedAt: at('03-17', '10') });
      approved(alice, { sessionId: id('a3'), goal: 'Add alert routing.', ticketRefs: [], branch: 'main', startedAt: at('03-20'), endedAt: at('03-20', '10') });
      expect((await digest(['push', '--repo', alice], { env })).stdout).toContain('Pushed 3 summaries to github.com/acme/webapp.');

      // A ticket linked after the push.
      expect((await digest(['link', 'a3000000', 'OPS-7', '--repo', alice], { env })).stdout).toBe('Linked a3000000 to OPS-7.\n');

      // Bob, from an HTTPS clone of the same repo.
      const bob = realpathSync(mkdtempSync(join(base, 'bob-')));
      execFileSync('git', ['init', '-q'], { cwd: bob });
      share(bob, 'https://github.com/acme/webapp.git', server.url, bobToken);
      approved(bob, { sessionId: id('b1'), goal: 'Speed up search.', ticketRefs: ['PROJ-160'], ticketSources: { 'PROJ-160': 'branch' }, branch: 'feature/PROJ-160-search', startedAt: at('03-15', '22'), endedAt: at('03-16', '02') });
      approved(bob, { sessionId: id('b2'), goal: 'Tune search ranking.', ticketRefs: ['PROJ-170'], ticketSources: { 'PROJ-170': 'branch' }, branch: 'feature/PROJ-170-ranking', startedAt: at('03-18'), endedAt: at('03-18', '10') });
      approved(bob, { sessionId: id('b3'), goal: 'Clean up old flags.', ticketRefs: [], branch: 'main', startedAt: at('04-02'), endedAt: at('04-02', '10') });
      expect((await digest(['push', '--repo', bob])).stdout).toContain('Pushed 3 summaries to github.com/acme/webapp.');

      // The tracker (a fake in Phase 6) knows two of the tickets.
      const tracker = new FakeTracker([
        { key: 'PROJ-142', title: 'Rate limit login', sprint: 'Sprint 1' },
        { key: 'PROJ-170', title: 'Search ranking (backlog)', sprint: null },
      ]);
      expect(await refreshTracker(store, tracker, REPO_ID)).toEqual({ asked: 5, known: 2 });

      const get = (query: string) => fetch(`${server.url}/v1/tickets?repoId=${encodeURIComponent(REPO_ID)}&${query}`, { headers: { authorization: `Bearer ${bobToken}` } }).then((r) => r.json() as Promise<TicketReport>);
      const all = await get('from=2026-03-01&to=2026-05-01');
      expect(shape(all)).toEqual({
        'Sprint 1': {
          'PROJ-142': ['Alice:c1a5e001:branch'],
          'PROJ-150': ['Alice:c1a5e001:commit'],
          'PROJ-160': ['Bob:b1000000:branch'],
        },
        'Sprint 2': { 'OPS-7': ['Alice:a3000000:manual'], unlinked: ['Alice:a2000000'] },
        '(no sprint)': { 'PROJ-170': ['Bob:b2000000:branch'], unlinked: ['Bob:b3000000'] },
      });
      expect(all).toMatchObject({ summaryCount: 6, developerCount: 2 });
      const ops7 = all.sprints[1]!.tickets[0]!.summaries[0]!.link;
      expect(ops7).toMatchObject({ source: 'manual', addedBy: 'alice', addedAt: expect.any(String) });
      expect(all.sprints[0]!.tickets[0]!.title).toBe('Rate limit login');

      // The noisy commit message created no links, and its text never left Alice's machine.
      const text = JSON.stringify(all);
      for (const noise of ['SHA-256', 'UTF-8', 'GPT-4', 'limiter tests']) expect(text).not.toContain(noise);
      const draftFile = readdirSync(join(alice, '.digest/summaries')).find((f) => f.includes('c1a5e001'))!;
      expect(readFileSync(join(alice, '.digest/summaries', draftFile), 'utf8')).not.toContain('limiter tests');

      // One sprint by name, from the CLI.
      expect(shape(await get(`sprint=${encodeURIComponent('Sprint 2')}`))).toEqual({ 'Sprint 2': { 'OPS-7': ['Alice:a3000000:manual'], unlinked: ['Alice:a2000000'] } });
      const cli = await digest(['tickets', '--sprint', 'Sprint 1', '--repo', bob]);
      expect(cli.stdout).toContain('Sprint 1 (2026-03-02 up to 2026-03-16)\n  PROJ-142  Rate limit login\n');
      expect(cli.stdout).toContain('    2026-03-15  Bob  Speed up search.  (branch)');
      expect(cli.stdout).toContain('2 summaries from 2 developers.');
    } finally {
      await server.close();
      await close();
    }
  }, 60_000);
});
