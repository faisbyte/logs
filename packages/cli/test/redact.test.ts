import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { base62, pick } from '../../core/test/redact/corpus.js';
import { runCli } from '../src/cli.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const BASIC = join(FIXTURES, 'claude-code/projects/-work-acme-webapp/c1a5e001-0000-4000-8000-000000000001.jsonl');
const ORIGINAL_PROMPT = 'Add rate limiting to the login endpoint: max 5 attempts per minute per IP.';
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// Fake secrets assembled at runtime (see core/test/redact/corpus.ts).
const secrets = {
  github: `ghp_${base62(36)}`,
  aws: `AKIA${pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`,
  password: `Tr0ub4dor-${base62(10)}`,
  email: 'jane.doe@example.org',
};
const prompt = `Deploy with ${secrets.github} and ${secrets.aws}; DB_PASSWORD=${secrets.password}; ping ${secrets.email} after.`;

/** The basic fixture, moved into `repo`, with secrets in the first prompt. */
function sessionIn(repo: string) {
  const claudeDir = tempDir('digest-redact-claude-');
  mkdirSync(join(claudeDir, 'projects/p'), { recursive: true });
  const text = readFileSync(BASIC, 'utf8').replaceAll('/work/acme-webapp', repo).replace(ORIGINAL_PROMPT, prompt);
  writeFileSync(join(claudeDir, 'projects/p/c1a5e001-0000-4000-8000-000000000001.jsonl'), text);
  return { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(claudeDir, 'none') };
}

async function run(argv: string[], env: Record<string, string>) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    cwd: tempDir('digest-cwd-'),
    env,
    homeDir: '/nonexistent-home',
  });
  return { exitCode, stdout, stderr };
}

const fragments = (secret: string) => Array.from({ length: Math.max(1, secret.length - 15) }, (_, i) => secret.slice(i, i + 16));

describe('sprintdigest redact', () => {
  const repo = tempDir('digest-redact-repo-');
  const env = sessionIn(repo);

  it('prints the count of each placeholder type for the session', async () => {
    const { exitCode, stdout } = await run(['redact', 'c1a5e001', '--repo', repo], env);
    expect(exitCode).toBe(0);
    expect(stdout.split('\n')[0]).toBe('c1a5e001-0000-4000-8000-000000000001 (claude-code): 4 values redacted');
    expect(stdout).toMatch(/^ {2}aws_key\s+1$/m);
    expect(stdout).toMatch(/^ {2}email\s+1$/m);
    expect(stdout).toMatch(/^ {2}env_secret\s+1$/m);
    expect(stdout).toMatch(/^ {2}github_token\s+1$/m);
  });

  it('never prints a matched value or any fragment of one', async () => {
    const { stdout, stderr } = await run(['redact', 'c1a5e001', '--repo', repo], env);
    for (const secret of Object.values(secrets)) {
      for (const fragment of fragments(secret)) expect(stdout + stderr).not.toContain(fragment);
    }
    expect(stdout).not.toContain('Deploy with');
  });

  it('applies the allow and deny lists from .digest/config.json', async () => {
    const configured = tempDir('digest-redact-config-');
    mkdirSync(join(configured, '.digest'));
    writeFileSync(join(configured, '.digest/config.json'), JSON.stringify({ redaction: { deny: ['login endpoint'], pii: { email: false } } }));
    const { stdout } = await run(['redact', 'c1a5e001', '--repo', configured], sessionIn(configured));
    expect(stdout).toMatch(/^ {2}deny_list\s+\d+$/m);
    expect(stdout).not.toMatch(/^ {2}email/m);
  });

  it('fails with a message when no session matches', async () => {
    const { exitCode, stderr } = await run(['redact', 'ffffffff', '--repo', repo], env);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('No session matching "ffffffff"');
  });

  it('lists the candidates when a prefix matches more than one session', async () => {
    const fixtureEnv = { CLAUDE_CONFIG_DIR: join(FIXTURES, 'claude-code'), CODEX_HOME: join(FIXTURES, 'codex') };
    const { exitCode, stderr } = await run(['redact', 'c1a5e00', '--repo', '/work/acme-webapp'], fixtureEnv);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('"c1a5e00" matches 3 sessions');
    expect(stderr).toContain('c1a5e002-0000-4000-8000-000000000002');
  });

  it('reports a broken config instead of crashing', async () => {
    const broken = tempDir('digest-redact-broken-');
    mkdirSync(join(broken, '.digest'));
    writeFileSync(join(broken, '.digest/config.json'), '{"redaction":{"denylist":[]}}');
    const { exitCode, stderr } = await run(['redact', 'c1a5e001', '--repo', broken], sessionIn(broken));
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/^sprintdigest redact: Invalid \.digest\/config\.json/);
  });
});
