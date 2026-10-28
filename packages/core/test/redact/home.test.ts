import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { redactSession } from '../../src/redact/session.js';
import { redactText } from '../../src/redact/text.js';
import { sessionWith } from './helpers.js';

const home = { dir: '/Users/jdoe', username: 'jdoe' };

describe('home directory', () => {
  it('replaces the home path with ~', () => {
    expect(redactText('/Users/jdoe/Documents/app/src/a.ts and cd /Users/jdoe', { home })).toEqual({
      text: '~/Documents/app/src/a.ts and cd ~',
      counts: { home_dir: 2 },
    });
  });

  it('only replaces whole path components', () => {
    expect(redactText('/Users/jdoe2/x', { home }).text).toBe('/Users/jdoe2/x');
  });

  it("replaces the encoded home in Claude Code's project directory names", () => {
    expect(redactText('/Users/jdoe/.claude/projects/-Users-jdoe-Documents-app/s.jsonl', { home }).text).toBe('~/.claude/projects/~-Documents-app/s.jsonl');
  });

  it('replaces the bare username elsewhere, as a whole word', () => {
    expect(redactText('drwxr-xr-x  jdoe  staff  src\njdoe@MacBook-Pro ~ % and jdoe2 stays', { home })).toEqual({
      text: 'drwxr-xr-x  [REDACTED:username]  staff  src\n[REDACTED:username]@MacBook-Pro ~ % and jdoe2 stays',
      counts: { username: 2 },
    });
  });

  it('replaces the username inside hyphen- and underscore-joined names', () => {
    expect(redactText('worktree-by-jdoe/notes and host jdoe-MacBook-Pro and jdoe_backup', { home }).text).toBe(
      'worktree-by-[REDACTED:username]/notes and host [REDACTED:username]-MacBook-Pro and [REDACTED:username]_backup',
    );
  });

  it('leaves generic usernames that identify nobody', () => {
    expect(redactText('/home/runner/work and the test runner failed', { home: { dir: '/home/runner', username: 'runner' } }).text).toBe(
      '~/work and the test runner failed',
    );
  });

  it("uses this machine's home directory by default", () => {
    expect(redactText(`${homedir()}/projects/app`).text).toBe('~/projects/app');
  });

  it('can be turned off', () => {
    expect(redactText('/Users/jdoe/x', { home: false }).text).toBe('/Users/jdoe/x');
  });

  it('is idempotent', () => {
    const once = redactText('/Users/jdoe/x jdoe', { home }).text;
    expect(redactText(once, { home }).text).toBe(once);
  });

  it('applies to every field of a session, including cwd and source path', () => {
    const { session } = redactSession(sessionWith('/Users/jdoe/Documents/app'), { home });
    expect(session.cwd).toBe('~/Documents/app');
    expect(session.sourcePath).toBe('~/Documents/app');
    expect(JSON.stringify(session)).not.toContain('jdoe');
  });
});
