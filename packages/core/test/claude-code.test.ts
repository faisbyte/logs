import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../src/parsers/claude-code.js';
import { ParsedSessionSchema } from '../src/schema.js';
import { claude, REPO } from './fixtures.js';

describe('parseClaudeCodeFile', () => {
  describe('metadata', () => {
    const session = parseClaudeCodeFile(claude.basic)!;

    it('produces a session that satisfies the schema', () => {
      expect(ParsedSessionSchema.parse(session)).toEqual(session);
    });

    it('identifies the agent, session and source file', () => {
      expect(session.agent).toBe('claude-code');
      expect(session.sourceSessionId).toBe('c1a5e001-0000-4000-8000-000000000001');
      expect(session.sourcePath).toBe(claude.basic);
    });

    it('takes cwd and branch from the first event that records them', () => {
      expect(session.cwd).toBe(REPO);
      expect(session.gitBranch).toBe('feature/PROJ-142-rate-limit');
      expect(session.gitBranches).toEqual(['feature/PROJ-142-rate-limit']);
    });

    it('spans the first to the last timestamped event', () => {
      expect(session.startedAt).toBe('2026-03-02T09:00:00.000Z');
      expect(session.endedAt).toBe('2026-03-02T09:00:54.000Z');
    });

    it('uses the last ai-title as the title', () => {
      expect(session.title).toBe('Rate limit login endpoint');
    });

    it('records agent versions and models', () => {
      expect(session.agentVersions).toEqual(['2.1.300']);
      expect(session.models).toEqual(['claude-opus-5-5']);
    });

    it('leaves commit SHAs for the git step to fill', () => {
      expect(session.commitShas).toEqual([]);
    });
  });
});
