import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

describe('built digest binary', () => {
  it('prints its version', () => {
    const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(out).toBe('0.1.0\n');
  });

  it('lists fixture sessions using the built core package', () => {
    const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
    const out = execFileSync(process.execPath, [bin, 'list', '--repo', '/work/acme-webapp'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: `${fixtures}claude-code`, CODEX_HOME: `${fixtures}codex` },
    });
    expect(out.trimEnd().split('\n').at(-1)).toBe('6 sessions for /work/acme-webapp (3 Claude Code, 3 Codex); 1 empty session hidden, --all shows it');
  });

  it('starts with a node shebang so package managers can link it', () => {
    expect(readFileSync(bin, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});
