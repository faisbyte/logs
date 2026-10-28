import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession } from '../../src/redact/session.js';
import type { ParsedSession } from '../../src/schema.js';
import { chunkTurns, condenseSession } from '../../src/summarize/condense.js';
import { estimateSummaryCost } from '../../src/summarize/estimate.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { systemPrompt } from '../../src/summarize/prompt.js';
import { summarizeSession } from '../../src/summarize/summarize.js';
import { claude } from '../fixtures.js';
import { llmSummary, pickAll } from './helpers.js';

const HOUR = 3_600_000;

/** The messy fixture with everything after the second prompt moved 20 hours later: a session resumed the next day. */
function resumedNextDay(): ParsedSession {
  const s = parseClaudeCodeFile(claude.messy)!;
  const secondPrompt = s.transcript.filter((e) => e.kind === 'user')[1]!;
  const cut = s.transcript.indexOf(secondPrompt);
  const shift = (iso: string) => new Date(Date.parse(iso) + 20 * HOUR).toISOString();
  return { ...s, endedAt: shift(s.endedAt), transcript: s.transcript.map((e, i) => (i >= cut ? { ...e, timestamp: shift(e.timestamp) } : e)) };
}

describe('sessions that span several work periods', () => {
  const redacted = redactSession(resumedNextDay(), { home: false });

  it('marks where the session resumed after a long gap', () => {
    const { turns, segmentStarts } = condenseSession(redacted);
    expect(segmentStarts).toEqual([0, 1]);
    expect(turns[1]).toMatch(/^\[resumed after 20 hours\]\nUSER: No Redis/);
  });

  it('lists the work periods and commits in the metadata', () => {
    const { metadata } = condenseSession(redactSession({ ...resumedNextDay(), commitShas: ['a'.repeat(40), 'b'.repeat(40)] }, { home: false }));
    expect(metadata).toContain('Work periods: 2 (separated by gaps of 6+ hours)');
    expect(metadata).toContain('Commits made during the session: 2');
  });

  it('never packs turns from different work periods into one chunk', () => {
    const { turns, segmentStarts } = condenseSession(redacted);
    expect(chunkTurns(turns, 60_000, segmentStarts)).toHaveLength(2);
    expect(chunkTurns(turns, 60_000)).toHaveLength(1);
  });

  it('summarises each work period, then merges them so the whole session is covered', async () => {
    const llm = new FakeLlmClient((request) =>
      request.system.startsWith('You are merging') ? pickAll(request, { goal: 'Speed up search over two days.', whatWasDone: 'Day one: cache. Day two: trigram index.', aiInvolvement: 'heavy' }) : JSON.stringify(llmSummary()),
    );
    const summary = await summarizeSession(redacted, llm, { chunkTokens: 60_000 });
    expect(llm.requests).toHaveLength(3);
    expect(summary.goal).toBe('Speed up search over two days.');
    expect(estimateSummaryCost(redacted, { model: 'claude-haiku-5-5', effort: 'low', chunkTokens: 60_000 }).requests).toBe(3);
  });

  it('keeps a single work period in one chunk', () => {
    const { segmentStarts } = condenseSession(redactSession(parseClaudeCodeFile(claude.messy)!, { home: false }));
    expect(segmentStarts).toEqual([0]);
  });

  it('tells the model to cover every task and never contradict the metadata', () => {
    expect(systemPrompt()).toContain('Sessions can span several tasks and work periods: "goal" and "whatWasDone" must cover all of them, weighted by how much work each took, not just the last one.');
    expect(systemPrompt()).toContain('Never contradict the session metadata');
  });
});
