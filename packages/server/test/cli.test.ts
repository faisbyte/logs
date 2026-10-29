import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore, serverCli, startServer } from '../src/cli.js';

async function cli(argv: string[], env: Record<string, string | undefined> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await serverCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env });
  return { exitCode, stdout, stderr };
}

describe('digest-server token', () => {
  it('issues a token once, for the normalised repo id, storing only its hash', async () => {
    const data = join(mkdtempSync(join(tmpdir(), 'digest-server-')), 'db');
    const { exitCode, stdout } = await cli(['token', '--data', data, '--repo', 'git@github.com:Acme/WebApp.git', '--developer', 'alice', '--name', 'Alice']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Token for Alice (alice) on github.com/acme/webapp. It is shown only this once:');
    const token = /^(dgt_\S+)$/m.exec(stdout)![1]!;
    const { store, close } = await openStore({ dataDir: data });
    expect(await store.authenticate(token)).toEqual({ repoId: 'github.com/acme/webapp', developerId: 'alice', developerName: 'Alice' });
    await close();
  });

  it('explains missing arguments and missing storage', async () => {
    expect((await cli(['token', '--data', '/tmp/x', '--repo', 'github.com/acme/webapp'])).stderr).toContain('--developer and --name are required');
    expect((await cli(['token', '--repo', 'a/b', '--developer', 'a', '--name', 'A'])).stderr).toContain('set DATABASE_URL or pass --data');
    expect((await cli(['token', '--data', '/tmp/x', '--repo', 'not a repo', '--developer', 'a', '--name', 'A'])).stderr).toContain('--repo must be a repo URL or host/path id');
    expect((await cli(['frobnicate'])).stderr).toContain('usage: digest-server');
  });
});

describe('startServer', () => {
  it('serves the API on the given port until closed', async () => {
    const data = join(mkdtempSync(join(tmpdir(), 'digest-server-')), 'db');
    const { store, close } = await openStore({ dataDir: data });
    const server = await startServer({ store, port: 0, log: () => {} });
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    await server.close();
    await close();
  });
});
