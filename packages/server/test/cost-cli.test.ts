import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { costAccess, isIngestToken } from '@digest/core';
import { costRecord } from '../../core/test/cost/cost-contract.js';
import { claudeRequest, logBatch } from '../../core/test/cost/otlp.js';
import { openStore, serverCli } from '../src/cli.js';
import { startTrial } from '../src/cost-cli.js';

// sprintdigest-server cost (Phase 12, D107): the admin's side.

const REPO = 'github.com/acme/webapp';
let data: string;
beforeEach(() => {
  data = join(mkdtempSync(join(tmpdir(), 'sprintdigest-cost-')), 'db');
});
async function cli(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const exitCode = await serverCli([...argv, '--data', data], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: {} });
  return { exitCode, stdout, stderr };
}
const cost = (...argv: string[]) => cli('cost', ...argv);
async function withStore<T>(work: (store: Awaited<ReturnType<typeof openStore>>['store']) => Promise<T>): Promise<T> {
  const { store, close } = await openStore({ dataDir: data });
  return work(store).finally(close);
}

describe('sprintdigest-server cost', () => {
  it('won’t turn tracking on until the admin confirms developers were told', async () => {
    const refused = await cost('enable', '--repo', REPO);
    expect(refused).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('--developers-told') });
    expect(await withStore((s) => s.costConfig('repo'))).toEqual([]);
    expect(await cost('enable', '--repo', REPO, '--developers-told')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining(`Cost tracking is on for ${REPO}`) });
    expect(await withStore((s) => s.costConfig('repo'))).toMatchObject([{ repoId: REPO, developersTold: true }]);
    expect(await cost('disable', '--repo', REPO)).toMatchObject({ exitCode: 0, stdout: `Cost tracking is off for ${REPO}. Nothing already recorded was deleted.\n` });
    expect((await cost('disable', '--repo', REPO)).exitCode).toBe(1);
  });

  it('registers, lists and removes accounts, warning when no organisation is set', async () => {
    const base = ['account', '--repo', REPO, '--developer', 'alice', '--name', 'Alice', '--email', 'Alice@acme.example'];
    expect(await cost(...base)).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('No --org') });
    const withOrg = await cost(...base, '--org', 'org-acme', '--billing', 'subscription');
    expect(withOrg.stdout).toBe(`Registered alice@acme.example as Alice (alice) on ${REPO}.\n`);
    expect((await cost('account', '--repo', REPO)).stdout).toBe(`Accounts on ${REPO}:\n  alice@acme.example  Alice (alice)  organisation org-acme  subscription\n`);
    expect(await cost('account', '--repo', REPO, '--email', 'alice@acme.example', '--developer', 'eve', '--name', 'Eve')).toMatchObject({ exitCode: 0 });
    expect((await cost(...base, '--billing', 'free')).stderr).toContain('--billing must be api or subscription');
    expect((await cost('account', '--repo', REPO, '--email', 'alice@acme.example', '--remove')).stdout).toBe(`Stopped recording alice@acme.example on ${REPO}. What was recorded stays in the report.\n`);
    expect((await cost('account', '--repo', REPO)).stdout).toBe(`No accounts on ${REPO}.\n`);
  });

  it('grants and revokes cost access, for a person with a reader token', async () => {
    const pat = { repoId: REPO, developerId: 'pat', developerName: 'Pat', role: 'reader' as const };
    await cost('enable', '--repo', REPO, '--developers-told');
    expect((await cost('grant', '--repo', REPO, '--reader', 'pat')).stdout).toBe(`pat can now see developer cost on ${REPO}.\n`);
    expect(await withStore((s) => costAccess(s, pat))).toBe('all');
    expect((await cost('grant', '--repo', REPO, '--reader', 'pat', '--revoke')).stdout).toBe(`pat can no longer see developer cost on ${REPO}.\n`);
    expect(await withStore((s) => costAccess(s, pat))).toBe('none');
    expect((await cost('grant', '--repo', REPO, '--reader', 'pat', '--revoke')).exitCode).toBe(1);
  });

  it('issues a telemetry token once, and revokes it', async () => {
    const { stdout } = await cost('telemetry-token', '--label', 'laptops');
    const token = /^(dgi_\S+)$/m.exec(stdout)![1]!;
    expect(await withStore((s) => isIngestToken(s, token))).toBe(true);
    expect((await cost('telemetry-token', '--label', 'laptops', '--revoke')).exitCode).toBe(0);
    expect(await withStore((s) => isIngestToken(s, token))).toBe(false);
  });

  it('keeps company repos and prices, and shows the whole setup without any token', async () => {
    await cost('enable', '--repo', REPO, '--developers-told');
    const { stdout: issued } = await cost('telemetry-token', '--label', 'laptops');
    await cost('grant', '--repo', REPO, '--reader', 'pat');
    expect((await cost('company', '--match', 'github.com/acme/*')).stdout).toBe('Company repos now include github.com/acme/*.\n');
    expect((await cost('company', '--match', '*')).exitCode).toBe(1);
    expect((await cost('price', '--model', 'gpt-test', '--since', '2026-04-01', '--input', '1.25', '--output', '10', '--cache-read', '0.125')).stdout).toBe('From 2026-04-01, gpt-test costs $1.25 in, $10 out, $0.125 cache read and $1.25 cache write per million tokens.\n');
    expect((await cost('price', '--model', 'gpt-test', '--since', '2026-04-01', '--input', 'free', '--output', '10')).exitCode).toBe(1);
    const { stdout } = await cost('status');
    expect(stdout).toContain(`${REPO}  on since `);
    for (const text of ['cost access: pat', 'github.com/acme/*', 'gpt-test from 2026-04-01', 'laptops', 'kept 365 days']) expect(stdout).toContain(text);
    expect(stdout).not.toContain(/^(dgi_\S+)$/m.exec(issued)![1]!);
    expect((await cost('company', '--match', 'github.com/acme/*', '--remove')).exitCode).toBe(0);
  });

  it('ages cost out with retention apply: 365 days unless set', async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    await withStore((s) => s.recordUsage([costRecord({ key: 'old', at: days(400) }), costRecord({ key: 'mid', at: days(100) }), costRecord({ key: 'new', at: days(1) })]));
    expect((await cli('retention', 'apply')).stdout).toContain('AI cost kept 365 days: deleted 1 record');
    await cost('retention', '--days', '30');
    expect((await cli('retention', 'apply')).stdout).toContain('AI cost kept 30 days: deleted 1 record');
    await cost('retention', '--days', 'forever');
    expect((await cli('retention', 'apply')).stdout).not.toContain('AI cost');
    expect((await cost('retention', '--days', '0')).exitCode).toBe(1);
  });

  it('deletes a developer’s cost data only with --yes, and records that', async () => {
    await cost('account', '--repo', REPO, '--developer', 'alice', '--name', 'Alice', '--email', 'alice@acme.example');
    await withStore((s) => s.recordUsage([costRecord()]));
    expect((await cost('delete', '--developer', 'alice')).exitCode).toBe(1);
    expect((await cost('delete', '--developer', 'alice', '--yes')).stdout).toBe("Deleted alice's AI cost data: 1 record, 0 commits, 0 flags.\n");
    expect(await withStore((s) => s.auditEvents(REPO))).toMatchObject([{ action: 'cost.deleted', actorId: 'admin', target: 'alice' }, { action: 'cost.account' }]);
  });

  it('explains an unknown subcommand and missing arguments', async () => {
    expect((await cost('nope')).stderr).toContain('usage: sprintdigest-server');
    expect((await cost('grant', '--repo', REPO)).stderr).toContain('--reader is required');
    expect((await cost('telemetry-token')).stderr).toContain('--label is required');
  });
});

describe('the local trial listener', () => {
  it('names the fields that arrive and whether they would be kept, and never prints a prompt or command', async () => {
    let out = '';
    const trial = await startTrial({ port: 0, stdout: (s) => (out += s) });
    const planted = 'please fix the login bug';
    const post = (body: string, type = 'application/json') => fetch(`${trial.url}/v1/logs`, { method: 'POST', headers: { 'content-type': type }, body });
    expect((await post(JSON.stringify(logBatch(claudeRequest({ prompt: planted }), { 'event.name': 'user_prompt', prompt: planted })))).status).toBe(200);
    await post('x', 'application/x-protobuf');
    await trial.close();
    expect(out).toContain('api_request: would be recorded');
    expect(out).toContain('  account alice@acme.example, organization.id org-acme');
    expect(out).toContain('  repo reported: yes; cost reported: yes');
    expect(out).toContain('user_prompt: ignored');
    expect(out).toContain('  fields: event.name, prompt');
    expect(out).toContain('not JSON');
    expect(out).not.toContain(planted);
  });

  it('needs no database', async () => {
    let stderr = '';
    expect(await serverCli(['cost', 'trial', '--port', 'x'], { stdout: () => {}, stderr: (s) => (stderr += s), env: {} })).toBe(1);
    expect(stderr).toContain('--port must be a port number');
  });
});
