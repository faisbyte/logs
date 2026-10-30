import { describe, expect, it } from 'vitest';
import { periodId, shortSessionId, splitByPeriod } from '../src/periods.js';
import { redactSession } from '../src/redact/session.js';
import { approve, uploadPayload } from '../src/review/approval.js';
import { ParsedSessionSchema, type ParsedSession, type TranscriptEntry } from '../src/schema.js';
import { InMemorySummaryStore } from '../src/shared/memory-store.js';
import { ticketReport } from '../src/shared/ticket-report.js';
import { FakeLlmClient } from '../src/summarize/fake-llm.js';
import { summarizeSession } from '../src/summarize/summarize.js';
import { llmSummary } from './summarize/helpers.js';

// sprintdigest summarize --by-period (DECISIONS.md D58): one summary per work period, split at the existing 6-hour gap.

const ID = 'f0000001-0000-4000-8000-000000000001';
const user = (timestamp: string, text: string): TranscriptEntry => ({ kind: 'user', timestamp, text });
const assistant = (timestamp: string, text: string): TranscriptEntry => ({ kind: 'assistant', timestamp, text });
const edit = (timestamp: string, path: string): TranscriptEntry => ({ kind: 'tool', timestamp, callId: `c-${timestamp}`, name: 'Edit', input: path, filePaths: [path], output: 'ok', outputTruncated: false, status: 'ok', exitCode: null });

function session(transcript: TranscriptEntry[], over: Partial<ParsedSession> = {}): ParsedSession {
  return ParsedSessionSchema.parse({
    agent: 'claude-code',
    sourceSessionId: ID,
    sourcePath: '/tmp/session.jsonl',
    agentVersions: ['2.1.300'],
    title: null,
    cwd: '/work/acme-webapp',
    gitBranch: 'main',
    gitBranches: ['main'],
    startedAt: transcript[0]!.timestamp,
    endedAt: transcript.at(-1)!.timestamp,
    models: ['claude-opus-5-5'],
    turnCount: transcript.filter((e) => e.kind === 'user').length,
    toolCallCount: transcript.filter((e) => e.kind === 'tool').length,
    filesTouched: [...new Set(transcript.flatMap((e) => (e.kind === 'tool' ? e.filePaths : [])))].sort(),
    commitShas: [],
    subagents: [],
    transcript,
    ...over,
  });
}

// Two work periods: the evening of 30 October, then the morning of 31 October after an 8-hour gap.
const twoPeriods = () =>
  session([
    user('2026-10-30T20:00:00.000Z', 'Add the limiter.'),
    edit('2026-10-30T20:10:00.000Z', '/work/acme-webapp/src/limit.ts'),
    assistant('2026-10-30T20:30:00.000Z', 'Added.'),
    user('2026-10-30T22:00:00.000Z', 'Now test it.'),
    assistant('2026-10-30T23:00:00.000Z', 'Tested.'),
    user('2026-10-31T07:00:00.000Z', 'Add the lockout notice.'),
    edit('2026-10-31T07:20:00.000Z', '/work/acme-webapp/src/notice.ts'),
    assistant('2026-10-31T08:00:00.000Z', 'Done.'),
  ]);

describe('splitByPeriod', () => {
  it('cuts a session at gaps of 6 hours or more, each period with its own id, times, counts and files', () => {
    const [p1, p2, ...rest] = splitByPeriod(twoPeriods());
    expect(rest).toEqual([]);
    expect(p1).toMatchObject({ sourceSessionId: `${ID}.p1`, startedAt: '2026-10-30T20:00:00.000Z', endedAt: '2026-10-30T23:00:00.000Z', turnCount: 2, toolCallCount: 1, filesTouched: ['/work/acme-webapp/src/limit.ts'] });
    expect(p2).toMatchObject({ sourceSessionId: `${ID}.p2`, startedAt: '2026-10-31T07:00:00.000Z', endedAt: '2026-10-31T08:00:00.000Z', turnCount: 1, toolCallCount: 1, filesTouched: ['/work/acme-webapp/src/notice.ts'] });
    expect(p1!.transcript).toHaveLength(5);
    expect(p2!.transcript).toHaveLength(3);
    expect(p2).toMatchObject({ sourcePath: '/tmp/session.jsonl', gitBranch: 'main', cwd: '/work/acme-webapp' });
  });

  it('starts the first period when the session started, even before its first transcript entry', () => {
    const s = { ...twoPeriods(), startedAt: '2026-10-30T19:59:57.000Z' };
    expect(splitByPeriod(s)[0]!.startedAt).toBe('2026-10-30T19:59:57.000Z');
  });

  it('keeps a gap just under 6 hours in one period, and still names a single period p1', () => {
    const near = session([user('2026-10-30T08:00:00.000Z', 'a'), assistant('2026-10-30T09:00:00.000Z', 'b'), user('2026-10-30T14:59:00.000Z', 'c'), assistant('2026-10-30T15:00:00.000Z', 'd')]);
    expect(splitByPeriod(near).map((p) => [p.sourceSessionId, p.startedAt, p.endedAt])).toEqual([[`${ID}.p1`, '2026-10-30T08:00:00.000Z', '2026-10-30T15:00:00.000Z']]);
  });

  it('puts a subagent in the period whose Task call names it, otherwise the first', () => {
    const task = { ...edit('2026-10-31T07:30:00.000Z', ''), name: 'Task', input: 'Review the notice copy', filePaths: [] };
    const s = session([...twoPeriods().transcript.slice(0, 6), task, ...twoPeriods().transcript.slice(6)], {
      subagents: [
        { agentType: 'general-purpose', description: 'Review the notice copy', prompt: 'p', finalText: 'f', filesTouched: [], toolCallCount: 4 },
        { agentType: 'general-purpose', description: 'Unmatched', prompt: 'p', finalText: 'f', filesTouched: [], toolCallCount: 2 },
      ],
    });
    const [p1, p2] = splitByPeriod(s);
    expect(p1!.subagents.map((a) => a.description)).toEqual(['Unmatched']);
    expect(p2!.subagents.map((a) => a.description)).toEqual(['Review the notice copy']);
    expect(p2!.toolCallCount).toBe(2 + 4);
  });
});

describe('period ids', () => {
  it('shortens to the first 8 characters plus the period', () => {
    expect(shortSessionId(`${ID}.p2`)).toBe('f0000001.p2');
    expect(shortSessionId(ID)).toBe('f0000001');
    expect(periodId(`${ID}.p2`)).toEqual({ sessionId: ID, period: 2 });
    expect(periodId(ID)).toEqual({ sessionId: ID, period: null });
  });
});

describe('a session that crosses a sprint boundary, summarised by period', () => {
  it('counts each period in the sprint it happened in', async () => {
    const REPO = 'github.com/acme/webapp';
    const store = new InMemorySummaryStore();
    await store.saveSprint(REPO, { name: 'Sprint 1', from: '2026-10-17T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' });
    await store.saveSprint(REPO, { name: 'Sprint 2', from: '2026-10-31T00:00:00.000Z', to: '2026-11-14T00:00:00.000Z' });
    const llm = new FakeLlmClient(() => JSON.stringify(llmSummary()));
    for (const period of splitByPeriod(twoPeriods())) {
      const summary = await summarizeSession(redactSession(period, { home: false }), llm, { chunkTokens: 15_000 });
      await store.push({ repoId: REPO, developerId: 'alice', developerName: 'Alice' }, uploadPayload(approve(summary)));
    }
    const sprintOf = async (name: string) => (await ticketReport(store, REPO, { sprint: name })).sprints.flatMap((g) => g.unlinked.map((s) => s.summary.sessionId));
    expect(await sprintOf('Sprint 1')).toEqual([`${ID}.p1`]);
    expect(await sprintOf('Sprint 2')).toEqual([`${ID}.p2`]);
  });
});
