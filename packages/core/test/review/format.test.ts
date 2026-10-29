import { describe, expect, it } from 'vitest';
import { approve, reject } from '../../src/review/approval.js';
import { formatSummary, SHARED_HEADER } from '../../src/review/format.js';
import { draftSummary } from './helpers.js';

const UTC = { timeZone: 'UTC' };

describe('formatSummary', () => {
  it('starts with a one-line header naming what is shared once pushed', () => {
    const [first] = formatSummary(draftSummary(), UTC).split('\n');
    expect(first).toBe(SHARED_HEADER);
    expect(SHARED_HEADER).toBe(
      'Shared with the team once pushed: goal, outcome, what was done, decisions, rejected approaches, risks and follow-ups, AI involvement, files touched, ticket refs, branch and dates. Never shared: the transcript.',
    );
  });

  it('shows the summary as readable text, not JSON', () => {
    const text = formatSummary(draftSummary(), UTC);
    expect(text).toContain('c1a5e001  claude-code  feature/PROJ-142-rate-limit  2026-03-02 09:00 → 09:30  draft');
    expect(text).toContain('Goal: Rate limit the login endpoint.');
    expect(text).toContain('Outcome: completed  ·  AI involvement: heavy');
    expect(text).toContain('What was done:\n  Added an in-memory sliding-window limiter to login.');
    expect(text).toContain('Decisions:\n  - Use an in-memory limiter (because: There is a single API instance.)');
    expect(text).toContain('Rejected approaches:\n  - A Redis-backed limiter (because: No Redis in this deployment.)');
    expect(text).toContain('Risks and follow-ups:\n  - The limiter will not hold across multiple instances.');
    expect(text).toContain('Files touched (2): src/middleware/rateLimit.ts, src/routes/login.ts');
    expect(text).toContain('Ticket refs: PROJ-142');
    expect(text).not.toMatch(/[{}"]/);
  });

  it('says "none" for empty lists', () => {
    expect(formatSummary(draftSummary({ decisions: [], ticketRefs: [] }), UTC)).toMatch(/Decisions: none[\s\S]*Ticket refs: none/);
  });

  it('shows who approved it, whether it was edited, and rejection', () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    expect(formatSummary(approve(draftSummary(), { now }).summary as ReturnType<typeof draftSummary>, UTC)).toContain('approved by the developer 2026-10-29 12:00');
    expect(formatSummary(approve(draftSummary(), { now, by: 'auto' }).summary as ReturnType<typeof draftSummary>, UTC)).toContain('approved automatically 2026-10-29 12:00');
    expect(formatSummary(draftSummary({ editedByDeveloper: true }), UTC)).toContain('draft, edited by the developer');
    expect(formatSummary(reject(draftSummary()), UTC)).toMatch(/  rejected$/m);
  });
});
