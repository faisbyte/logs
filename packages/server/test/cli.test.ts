import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestDepsFromEnv, openStore, serverCli, startServer } from '../src/cli.js';

async function cli(argv: string[], env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch) {
  let stdout = '';
  let stderr = '';
  const exitCode = await serverCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { exitCode, stdout, stderr };
}

describe('sprintdigest-server token', () => {
  it('issues a token once, for the normalised repo id, storing only its hash', async () => {
    const data = join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db');
    const { exitCode, stdout } = await cli(['token', '--data', data, '--repo', 'git@github.com:Acme/WebApp.git', '--developer', 'alice', '--name', 'Alice']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Token for Alice (alice) on github.com/acme/webapp. It is shown only this once:');
    const token = /^(dgt_\S+)$/m.exec(stdout)![1]!;
    const { store, close } = await openStore({ dataDir: data });
    expect(await store.authenticate(token)).toEqual({ repoId: 'github.com/acme/webapp', developerId: 'alice', developerName: 'Alice', role: 'developer' });
    await close();
  });

  it('issues a read-only token for a stakeholder with --reader', async () => {
    const data = join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db');
    const { exitCode, stdout } = await cli(['token', '--data', data, '--repo', 'github.com/acme/webapp', '--reader', 'pat', '--name', 'Pat (PO)']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Read-only token for Pat (PO) (pat) on github.com/acme/webapp: digests and reports only. It is shown only this once:');
    const token = /^(dgt_\S+)$/m.exec(stdout)![1]!;
    const { store, close } = await openStore({ dataDir: data });
    expect(await store.authenticate(token)).toMatchObject({ developerId: 'pat', role: 'reader' });
    await close();
  });

  it('explains missing arguments and missing storage', async () => {
    expect((await cli(['token', '--data', '/tmp/x', '--repo', 'github.com/acme/webapp'])).stderr).toContain('--developer (or --reader) and --name are required');
    expect((await cli(['token', '--repo', 'a/b', '--developer', 'a', '--name', 'A'])).stderr).toContain('set DATABASE_URL or pass --data');
    expect((await cli(['token', '--data', '/tmp/x', '--repo', 'not a repo', '--developer', 'a', '--name', 'A'])).stderr).toContain('--repo must be a repo URL or host/path id');
    expect((await cli(['frobnicate'])).stderr).toContain('usage: sprintdigest-server');
  });
});

describe('sprintdigest-server sprint (DECISIONS.md D45)', () => {
  const repo = ['--repo', 'git@github.com:Acme/WebApp.git'];

  it('adds, lists, replaces and removes the named date ranges of a repo', async () => {
    const data = ['--data', join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db')];
    const added = await cli(['sprint', ...data, ...repo, '--name', 'Sprint 1', '--from', '2026-03-02', '--to', '2026-03-16']);
    expect(added).toMatchObject({ exitCode: 0, stdout: 'Saved Sprint 1 on github.com/acme/webapp: 2026-03-02 up to 2026-03-16 (not included).\n' });
    await cli(['sprint', ...data, ...repo, '--name', 'Sprint 2', '--from', '2026-03-16', '--to', '2026-03-30T12:00:00Z']);
    expect((await cli(['sprint', ...data, ...repo])).stdout).toBe('Sprints on github.com/acme/webapp:\n  Sprint 1  2026-03-02 up to 2026-03-16\n  Sprint 2  2026-03-16 up to 2026-03-30T12:00:00.000Z\n');
    const overlap = await cli(['sprint', ...data, ...repo, '--name', 'Sprint 3', '--from', '2026-03-29', '--to', '2026-04-10']);
    expect(overlap).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('Sprint 3 overlaps Sprint 2') });
    expect((await cli(['sprint', ...data, ...repo, '--remove', '--name', 'Sprint 1'])).stdout).toBe('Removed Sprint 1 from github.com/acme/webapp.\n');
    expect((await cli(['sprint', ...data, ...repo, '--remove', '--name', 'Sprint 1'])).exitCode).toBe(1);
  });

  it('explains bad dates and missing arguments', async () => {
    const data = ['--data', join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db')];
    expect((await cli(['sprint', ...data, ...repo, '--name', 'S', '--from', 'next monday', '--to', '2026-03-16'])).stderr).toContain('--from and --to must be dates such as 2026-03-02');
    expect((await cli(['sprint', ...data, ...repo, '--name', 'S', '--from', '2026-03-02'])).stderr).toContain('--name, --from and --to are needed');
    expect((await cli(['sprint', ...data])).stderr).toContain('--repo is required');
  });
});

describe('sprintdigest-server repo (DECISIONS.md D54)', () => {
  const repo = ['--repo', 'github.com/acme/webapp'];

  it('shows the defaults, then changes what is asked and keeps the rest', async () => {
    const data = ['--data', join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db')];
    expect((await cli(['repo', ...data, ...repo])).stdout).toBe(
      'Digest settings for github.com/acme/webapp:\n  schedule: off\n  developer preview: off\n  email: none\n  slack: none\n  monthly LLM cost cap: the server default\n',
    );
    const set = await cli(['repo', ...data, ...repo, '--schedule', 'weekly', '--weekday', 'tue', '--since', '2026-03-01', '--preview-hours', '24', '--email', 'po@example.com,sm@example.com', '--slack-env', 'SLACK_WEBHOOK_URL', '--cap-usd', '2.5']);
    expect(set).toMatchObject({ exitCode: 0 });
    expect(set.stdout).toBe(
      'Digest settings for github.com/acme/webapp:\n  schedule: weekly on Tuesday, for periods ending after 2026-03-01\n  developer preview: 24 hours before sending\n  email: po@example.com, sm@example.com\n  slack: the webhook URL in SLACK_WEBHOOK_URL\n  monthly LLM cost cap: $2.50\n',
    );
    expect((await cli(['repo', ...data, ...repo, '--slack-env', 'none', '--cap-usd', 'default'])).stdout).toContain('  slack: none\n  monthly LLM cost cap: the server default\n');
    expect((await cli(['repo', ...data, ...repo, '--schedule', 'off'])).stdout).toContain('  schedule: off\n');
  });

  it('explains bad values', async () => {
    const data = ['--data', join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db')];
    for (const [flag, value, message] of <[string, string | undefined, string][]>[
      ['--schedule', 'daily', '--schedule must be off, weekly or sprint-end'],
      ['--weekday', 'someday', '--weekday must be a day such as mon, or 1 to 7'],
      ['--email', 'not-an-address', '--email must be addresses separated by commas, or none'],
      ['--slack-env', 'https://hooks.slack.com/x', '--slack-env is the name of a server environment variable that holds the webhook URL, such as SLACK_WEBHOOK_URL'],
      ['--cap-usd', 'lots', '--cap-usd must be a number of dollars, or default'],
      ['--cap-usd=-1', undefined, '--cap-usd must be a number of dollars, or default'],
      ['--preview-hours', '1000', '--preview-hours must be a whole number from 0 to 168'],
    ]) {
      expect((await cli(['repo', ...data, ...repo, flag!, ...(value === undefined ? [] : [value])])).stderr).toContain(message);
    }
  });
});

describe('sprintdigest-server digest send-due (DECISIONS.md D54)', () => {
  it('sends what is due once, and reports it; a second run sends nothing', async () => {
    const data = ['--data', join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db')];
    const repo = ['--repo', 'github.com/acme/webapp'];
    await cli(['sprint', ...data, ...repo, '--name', 'Sprint 1', '--from', '2026-03-02', '--to', '2026-03-16']);
    await cli(['repo', ...data, ...repo, '--schedule', 'sprint-end', '--since', '2026-03-01', '--slack-env', 'SLACK_WEBHOOK_URL']);
    const posts: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => (posts.push(String(init.body)), new Response('ok'))) as typeof fetch;
    const env = { SLACK_WEBHOOK_URL: 'https://hooks.example.test/not-real' };
    const first = await cli(['digest', 'send-due', ...data], env, fakeFetch);
    expect(first).toMatchObject({ exitCode: 0, stdout: 'github.com/acme/webapp  sprint:Sprint 1  sent to slack\n' });
    expect(JSON.parse(posts[0]!).text).toContain('No AI-assisted work was shared for this period.');
    expect((await cli(['digest', 'send-due', ...data], env, fakeFetch)).stdout).toBe('github.com/acme/webapp  sprint:Sprint 1  already sent\n');
    expect(posts).toHaveLength(1);
  });

  it('exits 1 when something due could not be sent, so cron can alert', async () => {
    const data = ['--data', join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db')];
    const repo = ['--repo', 'github.com/acme/webapp'];
    await cli(['sprint', ...data, ...repo, '--name', 'Sprint 1', '--from', '2026-03-02', '--to', '2026-03-16']);
    await cli(['repo', ...data, ...repo, '--schedule', 'sprint-end', '--since', '2026-03-01', '--slack-env', 'SLACK_WEBHOOK_URL']);
    expect(await cli(['digest', 'send-due', ...data])).toMatchObject({ exitCode: 1, stdout: 'github.com/acme/webapp  sprint:Sprint 1  not sent: slack: SLACK_WEBHOOK_URL is not set on the server\n' });
    expect((await cli(['digest', ...data])).stderr).toContain('usage: sprintdigest-server');
  });
});

describe('digestDepsFromEnv (DECISIONS.md D48, D53)', () => {
  it('defaults to Sonnet 5.5 at medium effort with a $10 monthly cap, and no model without a key', () => {
    expect(digestDepsFromEnv({})).toEqual({ llm: null, model: 'claude-sonnet-5-5', defaultCapUsd: 10 });
    const deps = digestDepsFromEnv({ ANTHROPIC_API_KEY: 'test-key-not-real', DIGEST_MODEL: 'claude-opus-5-5', DIGEST_EFFORT: 'high', DIGEST_MONTHLY_CAP_USD: '2.5' });
    expect(deps).toMatchObject({ model: 'claude-opus-5-5', defaultCapUsd: 2.5, llm: { model: 'claude-opus-5-5', effort: 'high' } });
    expect(JSON.stringify(deps)).not.toContain('test-key-not-real');
  });

  it('reads the jargon list from DIGEST_JARGON, replacing the default (DECISIONS.md D68)', () => {
    expect(digestDepsFromEnv({ DIGEST_JARGON: 'sprint board, burndown ,' })).toMatchObject({ jargon: ['sprint board', 'burndown'] });
    expect(digestDepsFromEnv({})).not.toHaveProperty('jargon');
  });

  it('rejects a nonsense cap or effort', () => {
    expect(() => digestDepsFromEnv({ DIGEST_MONTHLY_CAP_USD: 'lots' })).toThrow(/DIGEST_MONTHLY_CAP_USD must be a number of dollars/);
    expect(() => digestDepsFromEnv({ DIGEST_EFFORT: 'extreme' })).toThrow(/DIGEST_EFFORT must be one of low, medium, high, xhigh, max/);
  });
});

describe('startServer', () => {
  it('serves the API on the given port until closed', async () => {
    const data = join(mkdtempSync(join(tmpdir(), 'sprintdigest-server-')), 'db');
    const { store, close } = await openStore({ dataDir: data });
    const server = await startServer({ store, port: 0, log: () => {} });
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    await server.close();
    await close();
  });
});
