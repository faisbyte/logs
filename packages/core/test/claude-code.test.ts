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

  describe('user prompts', () => {
    const messy = parseClaudeCodeFile(claude.messy)!;
    const prompts = messy.transcript.filter((e) => e.kind === 'user').map((e) => e.text);

    it('keeps only what the human typed, without IDE context blocks', () => {
      expect(prompts).toEqual([
        'Search is slow. Put a Redis cache in front of the search query.',
        "No Redis. Ops won't run another service. Try a Postgres trigram index instead.",
        "Actually leave the migration for now. Add a TODO and we'll pair on it tomorrow.",
      ]);
    });

    it('counts only human prompts as turns', () => {
      expect(messy.turnCount).toBe(3);
    });

    it('records "[Request interrupted…]" markers as interruptions, not prompts', () => {
      expect(messy.transcript.filter((e) => e.kind === 'interruption')).toHaveLength(2);
    });

    it('skips compaction summaries', () => {
      const long = parseClaudeCodeFile(claude.long)!;
      expect(long.turnCount).toBe(60);
      expect(long.transcript.some((e) => e.kind === 'user' && e.text.startsWith('This session is being continued'))).toBe(false);
    });
  });
});
