// Opt-in (DIGEST_DOCKER_TESTS=1): the self-host stack from compose.yaml, built and run for real, then removed with its
// volumes. It uses its own project name and host ports, so it never touches a stack you run yourself.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PROJECT = 'logs-smoke';
const env = { ...process.env, LOGS_API_PORT: '8800', LOGS_WEB_PORT: '3200' };
const API = 'http://127.0.0.1:8800';
const WEB = 'http://127.0.0.1:3200';
const REPO = 'github.com/acme/webapp';

const compose = (...args: string[]) => execFileSync('docker', ['compose', '-p', PROJECT, ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
    compose('up', '-d', '--build', '--wait');
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
    expect(await who.json()).toEqual({ repoId: REPO, developerId: 'alice', developerName: 'Alice', role: 'developer' });
  });

  it('serves the dashboard, pointed at the API inside the stack', async () => {
    const page = await fetch(`${WEB}/sign-in`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Sign in to logs');
  });

  it('keeps its data in the Postgres volume when the server restarts', async () => {
    const token = tokenFrom(admin('token', '--repo', REPO, '--reader', 'pat', '--name', 'Pat'));
    compose('restart', 'server');
    await untilUp(`${API}/healthz`);
    const who = await fetch(`${API}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect((await who.json()).role).toBe('reader');
  }, 120_000);
});
