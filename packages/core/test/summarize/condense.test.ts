import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { parseCodexFile } from '../../src/parsers/codex.js';
import { redactSession, type RedactedSession } from '../../src/redact/session.js';
import { chunkTurns, condenseSession, estimateTokens } from '../../src/summarize/condense.js';
import { claude, codex } from '../fixtures.js';

const redacted = (file: string) => redactSession((parseClaudeCodeFile(file) ?? parseCodexFile(file))!, { home: false });

describe('condenseSession', () => {
  it('keeps prompts, assistant text, tool names and repo-relative paths, collapsing repeats', () => {
    expect(condenseSession(redacted(claude.basic)).turns).toEqual([
      [
        'USER: Add rate limiting to the login endpoint: max 5 attempts per minute per IP.',
        "ASSISTANT: I'll look at the login route first.",
        'TOOL Read src/routes/login.ts',
        'TOOL Bash',
        'ASSISTANT: No existing dependency. I will write a small in-memory sliding-window limiter rather than add a package, since there is a single API instance.',
        'TOOL Write src/middleware/rateLimit.ts',
        'TOOL Edit src/routes/login.ts',
        'TOOL Bash ×2',
        'ASSISTANT: Done. Login is limited to 5 attempts per minute per IP using an in-memory sliding window. This will not hold across multiple instances.',
      ].join('\n'),
    ]);
  });

  it('marks rejected and failed tools and interruptions, and drops reasoning and tool output', () => {
    const text = condenseSession(redacted(claude.messy)).turns.join('\n');
    expect(text).toContain('TOOL Edit src/search/index.ts (rejected by user)');
    expect(text).toContain('TOOL Bash (failed)');
    expect(text).toContain('[user interrupted]');
    expect(text).not.toContain('The query runs on every keystroke'); // reasoning
    expect(text).not.toContain('FAIL test/search.test.ts'); // tool output
  });

  it('starts a new turn at each user prompt', () => {
    const turns = condenseSession(redacted(claude.messy)).turns;
    expect(turns).toHaveLength(3);
    expect(turns.every((t) => t.startsWith('USER: '))).toBe(true);
  });

  it('puts metadata and subagents (condensed harder) in a header', () => {
    const { metadata } = condenseSession(redacted(claude.messy));
    expect(metadata).toContain('Agent: claude-code');
    expect(metadata).toContain('Branch: feature/PROJ-150-search');
    expect(metadata).toContain('Files changed (4): db/migrations/0042_search_trgm.sql, src/search/cache.ts, src/search/query.ts, src/search/ranking.ts');
    expect(metadata).toContain(
      'SUBAGENT general-purpose "Rewrite search query for trigram index": Rewrote the query to use similarity() ordering with a 0.3 threshold. Files: src/search/query.ts, src/search/ranking.ts',
    );
    expect(metadata).not.toContain('pg_trgm index.'); // the subagent's full prompt is left out
  });

  it('caps very long prompts and replies, keeping head and tail', () => {
    const base = parseClaudeCodeFile(claude.basic)!;
    const long = `${'start '.repeat(2000)}${'end '.repeat(2000)}`;
    const session = redactSession({ ...base, transcript: [{ kind: 'user', timestamp: base.startedAt, text: long }] }, { home: false });
    const [turn] = condenseSession(session).turns;
    expect(turn!.length).toBeLessThan(4200);
    expect(turn).toMatch(/^USER: start /);
    expect(turn).toMatch(/end $/);
    expect(turn).toContain('chars omitted');
  });

  it('condenses Codex sessions too', () => {
    expect(condenseSession(redacted(codex.messy)).turns[0]).toContain('TOOL apply_patch src/live/socket.ts');
  });

  it('refuses anything that is not a RedactedSession', () => {
    const raw = parseClaudeCodeFile(claude.basic)!;
    expect(() => condenseSession(raw as unknown as RedactedSession)).toThrow(/unredacted/);
  });
});

describe('estimateTokens', () => {
  it('assumes 2.5 characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(1001))).toBe(401);
  });
});

describe('chunkTurns', () => {
  const turns = condenseSession(redacted(claude.long)).turns;

  it('returns everything as one chunk when it fits', () => {
    expect(chunkTurns(['a', 'b'], 1_000)).toEqual(['a\nb']);
  });

  it('packs whole turns into chunks under the budget, in order, each turn exactly once', () => {
    const chunks = chunkTurns(turns, 500);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => estimateTokens(c) <= 500)).toBe(true);
    expect(chunks.join('\n')).toBe(turns.join('\n'));
  });

  it('splits a single turn that is bigger than the budget', () => {
    const big = Array.from({ length: 200 }, (_, i) => `TOOL Edit src/file${i}.ts`).join('\n');
    const chunks = chunkTurns([big], 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => estimateTokens(c) <= 100)).toBe(true);
    expect(chunks.join('\n')).toBe(big);
  });
});
