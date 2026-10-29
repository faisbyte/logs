import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLlmClient, InMemorySummaryStore, localPushTarget, type DigestOutput } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { payloadFor } from '../../core/test/shared/store-contract.js';
import { runCli, type CliIo } from '../src/cli.js';

// digest report (a report written locally with the caller's key, DECISIONS.md D53) and digest preview (D54).

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };
const output: DigestOutput = {
  overview: 'Login is safer.',
  tickets: [{ key: 'PROJ-142', achieved: 'Repeated attempts are limited.', aiInvolvement: 'AI wrote most of it.', keyDecisions: [] }],
  otherWork: null,
  risksAndOpenQuestions: [],
};

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

async function setup() {
  const store = new InMemorySummaryStore();
  await store.push(alice, payloadFor());
  const pushTarget = localPushTarget(store, (await store.issueToken(alice)).token);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-report-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/WebApp.git'], { cwd: repo });
  const llm = new FakeLlmClient(() => JSON.stringify(output), 'claude-sonnet-5-5');
  return { store, pushTarget, repo, llm };
}

describe('digest report', () => {
  it('shows the cost estimate, then writes the report with the caller’s model, and serves a repeat from the local cache', async () => {
    const { pushTarget, repo, llm } = await setup();
    const first = await run(['report', '--from', '2026-03-01', '--to', '2026-04-01', '--yes', '--repo', repo], { pushTarget, llm });
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toMatch(/^Report for 2026-03-01 to 2026-03-31 from 1 summary: 1 request to claude-sonnet-5-5, about [\d,]+ input and 3,000 output tokens, estimated \$0\.\d{4}\n/);
    expect(first.stdout).toContain('# AI work update: 2026-03-01 to 2026-03-31\n');
    expect(first.stdout).toContain('_Based on 1 summary that 1 developer chose to share._');
    const again = await run(['report', '--from', '2026-03-01', '--to', '2026-04-01', '--repo', repo], { pushTarget, llm });
    expect(again.stderr).toBe('Report for 2026-03-01 to 2026-03-31: cached, nothing sent.\n');
    expect(again.stdout).toBe(first.stdout);
    expect(llm.requests).toHaveLength(1);
  });

  it('asks before spending, and without a terminal needs --yes', async () => {
    const { pushTarget, repo, llm } = await setup();
    const noTerminal = await run(['report', '--sprint', 'Sprint 1', '--repo', repo], { pushTarget, llm });
    expect(noTerminal.stdout).toBe('Nothing was shared for Sprint 1, so there is nothing to report.\n');
    const unsure = await run(['report', '--from', '2026-03-01', '--to', '2026-04-01', '--repo', repo], { pushTarget, llm });
    expect(unsure).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('Re-run with --yes to confirm, or run it in a terminal to be asked.') });
    const declined = await run(['report', '--from', '2026-03-01', '--to', '2026-04-01', '--repo', repo], { pushTarget, llm, confirm: async () => false });
    expect(declined.stderr).toContain('Cancelled; nothing was sent.');
    expect(llm.requests).toEqual([]);
  });

  it('uses the model in .digest/config.json, and writes to --out inside the repo', async () => {
    const { pushTarget, repo } = await setup();
    mkdirSync(join(repo, '.digest'), { recursive: true });
    writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ share: {}, report: { model: 'claude-opus-5-5' } }));
    const llm = new FakeLlmClient(() => JSON.stringify(output), 'claude-opus-5-5');
    const result = await run(['report', '--from', '2026-03-01', '--to', '2026-04-01', '--yes', '--out', 'march.md', '--repo', repo], { pushTarget, llm });
    expect(result.stderr).toContain('1 request to claude-opus-5-5');
    expect(result.stdout).toBe('Wrote march.md\n');
    expect(readFileSync(join(repo, 'march.md'), 'utf8')).toContain('# AI work update: 2026-03-01 to 2026-03-31');
    const noDir = await run(['report', '--from', '2026-03-01', '--to', '2026-04-01', '--yes', '--out', 'reports/march.md', '--repo', repo], { pushTarget, llm });
    expect(noDir.stderr).toContain('reports does not exist; create it first');
    const outside = await run(['report', '--from', '2026-03-01', '--to', '2026-04-01', '--yes', '--out', '../elsewhere.md', '--repo', repo], { pushTarget, llm });
    expect(outside.stderr).toContain('--out must be a path inside the repo');
  });
});

describe('digest preview', () => {
  it('prints the digests waiting in developer preview', async () => {
    const { store, pushTarget, repo } = await setup();
    expect((await run(['preview', '--repo', repo], { pushTarget })).stdout).toBe('No digests are waiting in developer preview.\n');
    await store.saveDigest({ repoId: REPO_ID, kind: 'scheduled', periodKey: 'sprint:Sprint 1', periodLabel: 'Sprint 1', from: null, to: null, inputHash: 'h', promptVersion: 'digest-v1', model: 'm', markdown: '# AI work update: Sprint 1\n\nAll good.\n', summaryCount: 1, developerCount: 1, costUsd: 0, status: 'preview', previewUntil: '2026-03-17T06:00:00.000Z', createdAt: '2026-03-16T06:00:00.000Z' });
    expect((await run(['preview', '--repo', repo], { pushTarget })).stdout).toBe('Sprint 1: in preview until 2026-03-17 06:00 UTC, then sent.\n\n# AI work update: Sprint 1\n\nAll good.\n\n');
  });
});
