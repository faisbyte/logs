import type { ParsedSession, Subagent, TranscriptEntry } from './schema.js';
import { WORK_PERIOD_GAP_MS } from './summarize/condense.js';

// digest summarize --by-period (DECISIONS.md D58): a session cut into its work periods, at the same 6-hour gap
// the summariser uses (D28). Each period is a session of its own, with id "<session id>.p<n>", so redaction,
// caching, review, approval and push treat it like any other session.

const PERIOD = /^(.*)\.p(\d+)$/;

export function periodId(id: string): { sessionId: string; period: number | null } {
  const m = PERIOD.exec(id);
  return m ? { sessionId: m[1]!, period: Number(m[2]) } : { sessionId: id, period: null };
}

/** The first `length` characters of the session id, plus the period: "fe5d7843.p2". */
export function shortSessionId(id: string, length = 8): string {
  const { sessionId, period } = periodId(id);
  return `${sessionId.slice(0, length)}${period === null ? '' : `.p${period}`}`;
}

/** Transcript entries grouped by work period: a turn starts at each human prompt. */
function periods(transcript: readonly TranscriptEntry[]): TranscriptEntry[][] {
  const out: TranscriptEntry[][] = [];
  let last = -Infinity;
  for (const entry of transcript) {
    const at = Date.parse(entry.timestamp);
    if (out.length === 0 || (entry.kind === 'user' && at - last >= WORK_PERIOD_GAP_MS)) out.push([]);
    out.at(-1)!.push(entry);
    last = Math.max(last, at);
  }
  return out;
}

/** A subagent goes to the period with the Task call that names it; any it can't place go to the first. */
function placeSubagents(subagents: readonly Subagent[], groups: TranscriptEntry[][]): Subagent[][] {
  const placed: Subagent[][] = groups.map(() => []);
  for (const agent of subagents) {
    const i = groups.findIndex((g) => g.some((e) => e.kind === 'tool' && (e.name === 'Task' || e.name === 'Agent') && agent.description !== null && e.input.includes(agent.description)));
    placed[i === -1 ? 0 : i]!.push(agent);
  }
  return placed;
}

export function splitByPeriod(session: ParsedSession): ParsedSession[] {
  const groups = periods(session.transcript);
  if (groups.length === 0) return [{ ...session, sourceSessionId: `${session.sourceSessionId}.p1` }];
  const subagents = placeSubagents(session.subagents, groups);
  return groups.map((transcript, i) => {
    const tools = transcript.filter((e) => e.kind === 'tool');
    const paths = new Set([...tools.flatMap((t) => t.filePaths), ...subagents[i]!.flatMap((a) => a.filesTouched)]);
    const times = transcript.map((e) => Date.parse(e.timestamp));
    return {
      ...session,
      sourceSessionId: `${session.sourceSessionId}.p${i + 1}`,
      startedAt: i === 0 ? session.startedAt : new Date(Math.min(...times)).toISOString(),
      endedAt: new Date(Math.max(...times)).toISOString(),
      turnCount: transcript.filter((e) => e.kind === 'user').length,
      toolCallCount: tools.length + subagents[i]!.reduce((n, a) => n + a.toolCallCount, 0),
      filesTouched: session.filesTouched.filter((f) => paths.has(f)),
      commitShas: [],
      subagents: subagents[i]!,
      transcript,
    };
  });
}
