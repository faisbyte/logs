import { describe, expect, it } from 'vitest';
import { ParsedSessionSchema, type ParsedSession } from '../src/schema.js';

function validSession(): ParsedSession {
  return {
    agent: 'claude-code',
    sourceSessionId: 'c1a5e001-0000-4000-8000-000000000001',
    sourcePath: '/home/dev/.claude/projects/-work-app/c1a5e001-0000-4000-8000-000000000001.jsonl',
    agentVersions: ['2.1.300'],
    title: 'Rate limit login endpoint',
    cwd: '/work/app',
    gitBranch: 'feature/PROJ-142',
    gitBranches: ['feature/PROJ-142'],
    startedAt: '2026-03-02T09:00:00.000Z',
    endedAt: '2026-03-02T09:12:00.000Z',
    models: ['claude-opus-5-5'],
    turnCount: 1,
    toolCallCount: 1,
    filesTouched: ['/work/app/src/login.ts'],
    commitShas: [],
    subagents: [{ agentType: 'Explore', description: 'Find callers', prompt: 'Find callers of login()', finalText: 'Two callers.', filesTouched: [], toolCallCount: 2 }],
    transcript: [
      { kind: 'user', timestamp: '2026-03-02T09:00:00.000Z', text: 'Add rate limiting' },
      { kind: 'reasoning', timestamp: '2026-03-02T09:00:01.000Z', text: 'Look at the route first' },
      {
        kind: 'tool',
        timestamp: '2026-03-02T09:00:02.000Z',
        callId: 'toolu_1',
        name: 'Edit',
        input: '/work/app/src/login.ts',
        filePaths: ['/work/app/src/login.ts'],
        output: 'updated',
        outputTruncated: false,
        status: 'ok',
      },
      { kind: 'assistant', timestamp: '2026-03-02T09:00:03.000Z', text: 'Done' },
      { kind: 'interruption', timestamp: '2026-03-02T09:00:04.000Z' },
    ],
  };
}

describe('ParsedSessionSchema', () => {
  it('accepts a well-formed session', () => {
    expect(ParsedSessionSchema.safeParse(validSession()).success).toBe(true);
  });

  it('rejects an agent other than claude-code or codex', () => {
    const result = ParsedSessionSchema.safeParse({ ...validSession(), agent: 'cursor' });
    expect(result.success).toBe(false);
  });

  it('rejects timestamps that are not ISO 8601', () => {
    const result = ParsedSessionSchema.safeParse({ ...validSession(), startedAt: '02/03/2026 09:00' });
    expect(result.success).toBe(false);
  });

  it('rejects a session that ends before it starts', () => {
    const result = ParsedSessionSchema.safeParse({ ...validSession(), endedAt: '2026-03-02T08:59:59.000Z' });
    expect(result.success).toBe(false);
  });

  it('rejects negative or fractional counts', () => {
    expect(ParsedSessionSchema.safeParse({ ...validSession(), turnCount: -1 }).success).toBe(false);
    expect(ParsedSessionSchema.safeParse({ ...validSession(), toolCallCount: 1.5 }).success).toBe(false);
  });

  it('rejects an unknown tool status', () => {
    const session = validSession();
    session.transcript[2] = { ...session.transcript[2], status: 'maybe' } as never;
    expect(ParsedSessionSchema.safeParse(session).success).toBe(false);
  });
});
