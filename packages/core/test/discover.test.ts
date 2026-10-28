import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentDirs, discoverSessionFiles, loadSessions } from '../src/discover.js';
import { CLAUDE_PROJECTS, CODEX_SESSIONS, claude, codex, FIXTURES } from './fixtures.js';

const dirs = { claudeProjectsDir: CLAUDE_PROJECTS, codexSessionsDir: CODEX_SESSIONS };

describe('agentDirs', () => {
  it('defaults to ~/.claude/projects and ~/.codex/sessions', () => {
    expect(agentDirs({}, '/home/dev')).toEqual({
      claudeProjectsDir: '/home/dev/.claude/projects',
      codexSessionsDir: '/home/dev/.codex/sessions',
    });
  });

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    expect(agentDirs({ CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' }, '/home/dev')).toEqual({
      claudeProjectsDir: '/cfg/claude/projects',
      codexSessionsDir: '/cfg/codex/sessions',
    });
  });
});

describe('discoverSessionFiles', () => {
  it('finds main Claude Code transcripts but not subagent, meta or spilled tool files', () => {
    const files = discoverSessionFiles(dirs).filter((f) => f.agent === 'claude-code');
    expect(files.map((f) => f.path).sort()).toEqual(Object.values(claude).sort());
  });

  it('finds Codex rollouts in nested date folders', () => {
    const files = discoverSessionFiles(dirs).filter((f) => f.agent === 'codex');
    expect(files.map((f) => f.path).sort()).toEqual(Object.values(codex).sort());
  });

  it('returns nothing when an agent was never installed', () => {
    const missing = join(FIXTURES, 'does-not-exist');
    expect(discoverSessionFiles({ claudeProjectsDir: missing, codexSessionsDir: missing })).toEqual([]);
  });
});

describe('loadSessions', () => {
  it('parses each file with the parser for its agent', () => {
    const sessions = loadSessions(discoverSessionFiles(dirs));
    expect(sessions).toHaveLength(9);
    expect(sessions.filter((s) => s.agent === 'claude-code')).toHaveLength(4);
    expect(sessions.find((s) => s.sourcePath === codex.basic)?.agent).toBe('codex');
  });
});
