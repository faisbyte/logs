import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../src/parsers/claude-code.js';
import { parseCodexFile } from '../src/parsers/codex.js';
import { isInRepo } from '../src/repo.js';
import { claude, codex, REPO } from './fixtures.js';

describe('isInRepo', () => {
  it('matches a session launched at the repo root', () => {
    expect(isInRepo({ cwd: REPO }, REPO)).toBe(true);
  });

  it('matches a session launched in a subdirectory of the repo', () => {
    expect(isInRepo({ cwd: `${REPO}/packages/api` }, REPO)).toBe(true);
  });

  it('does not match a sibling directory that shares the name prefix', () => {
    expect(isInRepo({ cwd: `${REPO}-legacy` }, REPO)).toBe(false);
  });

  it('does not match a parent directory of the repo', () => {
    expect(isInRepo({ cwd: '/work' }, REPO)).toBe(false);
  });

  it('ignores trailing slashes on either path', () => {
    expect(isInRepo({ cwd: `${REPO}/` }, `${REPO}/`)).toBe(true);
  });

  it('selects the fixture sessions that were launched inside the repo', () => {
    const sessions = [
      ...Object.values(claude).map(parseClaudeCodeFile),
      ...Object.values(codex).map(parseCodexFile),
    ].filter((s) => s !== null);
    expect(sessions.filter((s) => isInRepo(s, REPO)).map((s) => s.sourceSessionId.slice(0, 8))).toEqual([
      'c1a5e001',
      'c1a5e002',
      'c1a5e003',
      '019c0001',
      '019c0002',
      '019c0003',
      '019c0004',
    ]);
  });
});
