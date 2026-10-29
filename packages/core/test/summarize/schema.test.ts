import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession } from '../../src/redact/session.js';
import { buildSessionSummary, LlmSummarySchema, postCheck, SessionSummarySchema, type LlmSummary } from '../../src/summarize/schema.js';
import { claude, REPO } from '../fixtures.js';
import { llmSummary } from './helpers.js';

describe('LlmSummarySchema', () => {
  it('accepts a well-formed summary', () => {
    expect(LlmSummarySchema.safeParse(llmSummary()).success).toBe(true);
  });

  it('rejects unknown outcomes and involvement levels', () => {
    expect(LlmSummarySchema.safeParse({ ...llmSummary(), outcome: 'done' }).success).toBe(false);
    expect(LlmSummarySchema.safeParse({ ...llmSummary(), aiInvolvement: 'total' }).success).toBe(false);
  });

  it('rejects metadata keys, so the model cannot supply files, tickets, branch or timestamps', () => {
    for (const key of ['filesTouched', 'ticketRefs', 'branch', 'startedAt']) {
      expect(LlmSummarySchema.safeParse({ ...llmSummary(), [key]: ['x'] }).success).toBe(false);
    }
  });
});

describe('postCheck', () => {
  it('passes a clean summary', () => {
    expect(postCheck(llmSummary())).toEqual([]);
  });

  it('flags code blocks and redaction placeholders, naming the field', () => {
    const bad = llmSummary({
      whatWasDone: 'Changed it:\n```ts\nlogin.post()\n```',
      decisions: [{ decision: 'Rotate the key', reason: 'It was [REDACTED:github_token].' }],
    });
    expect(postCheck(bad)).toEqual(['whatWasDone contains a code block', 'decisions[0].reason contains a redaction placeholder']);
  });
});

describe('buildSessionSummary', () => {
  const redacted = redactSession(parseClaudeCodeFile(claude.basic)!, { home: false });
  const meta = { model: 'claude-haiku-5-5', promptVersion: 'summarize-v1', generatedAt: '2026-10-28T10:00:00.000Z', usage: { inputTokens: 900, outputTokens: 300, requests: 1, costUsd: 0.00024 } };

  it('takes files, tickets, branch and timestamps from the session, and the narrative from the model', () => {
    const summary = buildSessionSummary(llmSummary(), redacted, meta);
    expect(SessionSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({
      sessionId: 'c1a5e001-0000-4000-8000-000000000001',
      agent: 'claude-code',
      status: 'draft',
      goal: 'Rate limit the login endpoint.',
      filesTouched: ['src/middleware/rateLimit.ts', 'src/routes/login.ts'],
      ticketRefs: ['PROJ-142'],
      branch: 'feature/PROJ-142-rate-limit',
      startedAt: '2026-03-02T09:00:00.000Z',
      endedAt: '2026-03-02T09:00:54.000Z',
      editedByDeveloper: false,
      approvedAt: null,
      model: 'claude-haiku-5-5',
      promptVersion: 'summarize-v1',
    });
    expect(redacted.session.cwd).toBe(REPO);
  });

  it('records where each ticket key came from', () => {
    expect(buildSessionSummary(llmSummary(), redacted, meta).ticketSources).toEqual({ 'PROJ-142': 'branch' });
  });

  it('reads summaries written before ticket sources existed', () => {
    const { ticketSources: _, ...legacy } = buildSessionSummary(llmSummary(), redacted, meta);
    expect(SessionSummarySchema.parse(legacy).ticketSources).toEqual({});
  });

  it('ignores anything else the model object carries', () => {
    const smuggled = { ...llmSummary(), filesTouched: ['/etc/passwd'], ticketRefs: ['FAKE-1'], branch: 'evil' } as LlmSummary;
    const summary = buildSessionSummary(smuggled, redacted, meta);
    expect(summary.filesTouched).toEqual(['src/middleware/rateLimit.ts', 'src/routes/login.ts']);
    expect(summary.ticketRefs).toEqual(['PROJ-142']);
    expect(summary.branch).toBe('feature/PROJ-142-rate-limit');
    expect(summary).not.toHaveProperty('reversedDecisions');
  });
});
