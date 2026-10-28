import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  describe('assistant output and tool calls', () => {
    const basic = parseClaudeCodeFile(claude.basic)!;
    const messy = parseClaudeCodeFile(claude.messy)!;
    const tool = (name: string, input: string) =>
      messy.transcript.find((e) => e.kind === 'tool' && e.name === name && e.input === input);

    it('keeps the conversation in order, with one-line tool summaries', () => {
      const lines = basic.transcript.map((e) =>
        e.kind === 'tool' ? `${e.name}(${e.input}) ${e.status}` : `${e.kind}: ${'text' in e ? e.text : ''}`,
      );
      expect(lines).toEqual([
        'user: Add rate limiting to the login endpoint: max 5 attempts per minute per IP.',
        "assistant: I'll look at the login route first.",
        `Read(${REPO}/src/routes/login.ts) ok`,
        'Bash(grep -n "rate" package.json) ok',
        'assistant: No existing dependency. I will write a small in-memory sliding-window limiter rather than add a package, since there is a single API instance.',
        `Write(${REPO}/src/middleware/rateLimit.ts) ok`,
        `Edit(${REPO}/src/routes/login.ts) ok`,
        'Bash(pnpm test) ok',
        'Bash(git add -A && git commit -q -m "PROJ-142: rate limit login endpoint") ok',
        'assistant: Done. Login is limited to 5 attempts per minute per IP using an in-memory sliding window. This will not hold across multiple instances.',
      ]);
    });

    it('counts tool calls', () => {
      expect(basic.toolCallCount).toBe(6);
    });

    it('captures tool output text and the paths a call refers to', () => {
      const read = basic.transcript.find((e) => e.kind === 'tool' && e.name === 'Read');
      expect(read).toMatchObject({
        filePaths: [`${REPO}/src/routes/login.ts`],
        output: expect.stringContaining("login.post('/login', handler);"),
        outputTruncated: false,
      });
    });

    it('never puts written file contents into the tool input', () => {
      const write = basic.transcript.find((e) => e.kind === 'tool' && e.name === 'Write');
      expect(write).toMatchObject({ input: `${REPO}/src/middleware/rateLimit.ts` });
    });

    it('marks rejected and failed tool calls', () => {
      expect(tool('Bash', 'pnpm add redis')).toMatchObject({ status: 'rejected' });
      expect(tool('Bash', 'cd /tmp && pnpm --dir /work/acme-webapp test')).toMatchObject({ status: 'error' });
    });

    it('summarises subagent calls by type and description, with their text result', () => {
      expect(tool('Agent', 'general-purpose: Rewrite search query for trigram index')).toMatchObject({
        status: 'ok',
        output: 'Rewrote the query to use similarity() ordering with a 0.3 threshold.',
      });
    });

    it('lists files changed by successful Write and Edit calls, but not reads', () => {
      expect(basic.filesTouched).toEqual([`${REPO}/src/middleware/rateLimit.ts`, `${REPO}/src/routes/login.ts`]);
    });

    it('does not count an edit the user rejected as touched', () => {
      expect(messy.filesTouched).not.toContain(`${REPO}/src/search/index.ts`);
    });

    it('counts MultiEdit and NotebookEdit as edits', () => {
      const long = parseClaudeCodeFile(claude.long)!;
      expect(long.filesTouched).toContain(`${REPO}/notebooks/audit-volume.ipynb`);
      expect(long.filesTouched).toContain(`${REPO}/packages/api/src/admin/teams.ts`);
    });

    it('keeps non-empty reasoning and drops signature-only thinking', () => {
      expect(basic.transcript.filter((e) => e.kind === 'reasoning')).toEqual([]);
      expect(messy.transcript.filter((e) => e.kind === 'reasoning').map((e) => 'text' in e && e.text)).toEqual([
        'The query runs on every keystroke; a cache keyed by query string should help.',
      ]);
    });
  });

  describe('sessions that move around', () => {
    const long = parseClaudeCodeFile(claude.long)!;

    it('keeps the launch cwd even after the session changes directory', () => {
      expect(long.cwd).toBe(`${REPO}/packages/api`);
      expect(parseClaudeCodeFile(claude.other)!.cwd).toBe('/work/acme-webapp-legacy');
    });

    it('records every branch and version in the order they appeared', () => {
      expect(long.gitBranch).toBe('main');
      expect(long.gitBranches).toEqual(['main', 'feature/PROJ-160-audit-log']);
      expect(long.agentVersions).toEqual(['2.1.296', '2.1.300']);
    });
  });

  describe('damaged or empty files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'digest-claude-'));
    const write = (name: string, text: string) => {
      const file = join(tmp, name);
      writeFileSync(file, text);
      return file;
    };

    it('ignores a half-written last line from a session still in progress', () => {
      const lines = readFileSync(claude.basic, 'utf8').trimEnd();
      const file = write('partial.jsonl', `${lines}\n{"type":"assistant","message":{"con`);
      expect(parseClaudeCodeFile(file)?.turnCount).toBe(1);
    });

    it('returns null for a file with no conversation in it', () => {
      const file = write('empty.jsonl', '{"type":"ai-title","aiTitle":"x","sessionId":"s"}\n');
      expect(parseClaudeCodeFile(file)).toBeNull();
    });
  });

  describe('subagents', () => {
    const messy = parseClaudeCodeFile(claude.messy)!;

    it('adds files edited by subagents to the parent session', () => {
      expect(messy.filesTouched).toEqual([
        `${REPO}/db/migrations/0042_search_trgm.sql`,
        `${REPO}/src/search/cache.ts`,
        `${REPO}/src/search/query.ts`,
        `${REPO}/src/search/ranking.ts`,
      ]);
    });

    it('adds subagent tool calls to the parent count', () => {
      // 8 calls in the main transcript + 3 made by the subagent.
      expect(messy.toolCallCount).toBe(11);
    });

    it('keeps subagent prompts and messages out of the parent transcript', () => {
      const texts = messy.transcript.filter((e) => 'text' in e).map((e) => ('text' in e ? e.text : ''));
      expect(texts).not.toContain('Rewrite src/search/query.ts to use similarity() with the pg_trgm index.');
      expect(messy.transcript.filter((e) => e.kind === 'tool')).toHaveLength(8);
    });
  });
});
