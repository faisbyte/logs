import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, saveSummary } from '@digest/core';
import { afterEach, describe, expect, it } from 'vitest';
import { draftSummary } from '../../core/test/review/helpers.js';
import { runCli } from '../src/cli.js';

const TOKEN = 'dgt_file_token_value_0123456789abcdef';
const ENV_TOKEN = 'dgt_env_token_value_0123456789abcdef';
let close: (() => void) | undefined;
afterEach(() => close?.());

/** A stand-in digest server that accepts every push and records the request headers. */
async function stubServer() {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume().on('end', () => res.writeHead(201, { 'content-type': 'application/json' }).end('{"status":"created"}'));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () => server.close();
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function repoWith(config: object, token?: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-share-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/webapp.git'], { cwd: repo });
  mkdirSync(join(repo, '.digest'));
  writeFileSync(join(repo, '.digest/config.json'), JSON.stringify(config));
  if (token) writeFileSync(join(repo, '.digest/token'), `${token}\n`);
  saveSummary(repo, approve(draftSummary()).summary as ReturnType<typeof draftSummary>);
  return repo;
}

async function push(repo: string, env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(['push', '--repo', repo], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', env });
  return { exitCode, stdout, stderr };
}

describe('the shared store from .digest/config.json', () => {
  it('pushes to share.url with the token from .digest/token', async () => {
    const server = await stubServer();
    const { exitCode, stdout } = await push(repoWith({ share: { url: server.url } }, TOKEN));
    expect(exitCode).toBe(0);
    expect(server.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(stdout).not.toContain(TOKEN);
  });

  it('prefers DIGEST_TOKEN from the environment', async () => {
    const server = await stubServer();
    await push(repoWith({ share: { url: server.url } }, TOKEN), { DIGEST_TOKEN: ENV_TOKEN });
    expect(server.seen[0]!.authorization).toBe(`Bearer ${ENV_TOKEN}`);
  });

  it('explains a missing token without pushing', async () => {
    const server = await stubServer();
    const { exitCode, stderr } = await push(repoWith({ share: { url: server.url } }));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('no token for the shared store: put the token your digest-server admin gave you in .digest/token, or set DIGEST_TOKEN.');
    expect(server.seen).toEqual([]);
  });

  it('rejects a share.url that is not an http(s) URL', async () => {
    const { exitCode, stderr } = await push(repoWith({ share: { url: 'ftp://example.com' } }, TOKEN));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('.digest/config.json');
  });

  it('reports an unreachable server without echoing the token', async () => {
    const { exitCode, stderr } = await push(repoWith({ share: { url: 'http://127.0.0.1:9' } }, TOKEN));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('could not reach the shared store at http://127.0.0.1:9');
    expect(stderr).not.toContain(TOKEN);
  });
});
