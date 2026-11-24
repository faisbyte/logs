// Opt-in (DIGEST_DOCKER_TESTS=1): the self-host stack from compose.yaml, built and run for real, then removed with its
// volumes. It uses its own project name and host ports, so it never touches a stack you run yourself.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attributes, claudeRequest } from '../../core/test/cost/otlp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PROJECT = 'logs-smoke';
const env = { ...process.env, LOGS_API_PORT: '8800', LOGS_WEB_PORT: '3200', LOGS_OTLP_PORT: '4319' };
const API = 'http://127.0.0.1:8800';
const WEB = 'http://127.0.0.1:3200';
const REPO = 'github.com/acme/webapp';

const compose = (...args: string[]) => composeWith({}, ...args);
const composeWith = (extra: Record<string, string>, ...args: string[]) => execFileSync('docker', ['compose', '-p', PROJECT, '--profile', 'cost', ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** The admin command, run inside the server container the way the self-host docs say. */
const admin = (...args: string[]) => compose('exec', '-T', 'server', 'sprintdigest-server', ...args);
const tokenFrom = (output: string) => /\b(dgt_[A-Za-z0-9_-]+)/.exec(output)?.[1] ?? '';

async function untilUp(url: string, ms = 60_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 1000))) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
  }
  throw new Error(`${url} did not come up`);
}

describe.skipIf(!process.env.DIGEST_DOCKER_TESTS)('self-host with Docker Compose', () => {
  beforeAll(() => {
    compose('up', '-d', '--build', '--wait', 'server', 'jobs', 'web');
  }, 900_000);
  afterAll(() => {
    compose('down', '-v', '--remove-orphans');
  }, 120_000);

  it('serves the API from Postgres, issues a token with the admin command, and that token signs in', async () => {
    expect(await (await fetch(`${API}/healthz`)).json()).toEqual({ ok: true });
    const token = tokenFrom(admin('token', '--repo', REPO, '--developer', 'alice', '--name', 'Alice'));
    expect(token).not.toBe('');
    const started = await fetch(`${API}/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(started.status).toBe(201);
    const who = await fetch(`${API}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(await who.json()).toEqual({ repoId: REPO, developerId: 'alice', developerName: 'Alice', role: 'developer', costAccess: 'off' });
  });

  it('serves the dashboard, pointed at the API inside the stack', async () => {
    const page = await fetch(`${WEB}/sign-in`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Sign in to logs');
  });

  it('takes usage through the collector, which drops everything else first (D107)', async () => {
    admin('cost', 'enable', '--repo', REPO, '--developers-told');
    admin('cost', 'account', '--repo', REPO, '--email', 'alice@acme.example', '--developer', 'alice', '--name', 'Alice', '--org', 'org-acme');
    admin('cost', 'grant', '--repo', REPO, '--reader', 'morgan');
    const reader = tokenFrom(admin('token', '--repo', REPO, '--reader', 'morgan', '--name', 'Morgan'));
    const telemetry = /\b(dgi_[A-Za-z0-9_-]+)/.exec(admin('cost', 'telemetry-token', '--label', 'smoke'))![1]!;
    composeWith({ LOGS_TELEMETRY_TOKEN: telemetry }, 'up', '-d', 'collector');
    // The pull blocks this process, so the server may have closed our idle connection.
    await untilUp(`${API}/healthz`);
    const at = new Date(Date.now() + 1000).toISOString();
    const planted = 'planted prompt text';
    const record = (values: Record<string, string | number>) => ({ timeUnixNano: String(Date.now() * 1e6), body: { stringValue: planted }, attributes: attributes(values) });
    const body = JSON.stringify({ resourceLogs: [{ resource: { attributes: attributes({ 'host.name': planted }) }, scopeLogs: [{ logRecords: [record(claudeRequest({ 'event.timestamp': at, prompt: planted })), record({ 'event.name': 'user_prompt', prompt: planted })] }] }] });
    const cost = async () => (await (await fetch(`${API}/v1/cost?repoId=${encodeURIComponent(REPO)}&from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`, { headers: { authorization: `Bearer ${reader}` } })).json()) as { sessions: unknown[] };
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !(await cost()).sessions.length; await new Promise((r) => setTimeout(r, 1000))) {
      await fetch('http://127.0.0.1:4319/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => undefined);
    }
    expect(await cost()).toMatchObject({ totalMicros: 250_000, sessions: [{ developerId: 'alice', place: 'shared' }] });
    expect(JSON.stringify(await cost())).not.toContain(planted);
  }, 180_000);

  it('keeps its data in the Postgres volume when the server restarts', async () => {
    const token = tokenFrom(admin('token', '--repo', REPO, '--reader', 'pat', '--name', 'Pat'));
    compose('restart', 'server');
    await untilUp(`${API}/healthz`);
    const who = await fetch(`${API}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect((await who.json()).role).toBe('reader');
  }, 120_000);
});
