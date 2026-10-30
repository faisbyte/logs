import { assertRedactedSession, type DeepReadonly, type RedactedSession } from '../redact/session.js';
import type { ParsedSession, TranscriptEntry } from '../schema.js';

// What the summariser sees (DECISIONS.md D22): user prompts, assistant text, tool names and paths,
// plus markers for rejected/failed tools and interruptions. No reasoning, no tool output.

const MAX_PROMPT_CHARS = 4_000;
const MAX_REPLY_CHARS = 2_000;
const MAX_SUBAGENT_CHARS = 300;
const MAX_FILES_LISTED = 50;
const MAX_COMMAND_CHARS = 120;
const SHELL_TOOLS = new Set(['Bash', 'shell']);

function commandLine(input: string): string {
  const first = input.split('\n')[0]!.trim();
  return first.length > MAX_COMMAND_CHARS ? `${first.slice(0, MAX_COMMAND_CHARS)}…` : first;
}

export interface CondensedSession {
  /** Session facts and subagents; sent with every chunk. */
  metadata: string;
  /** One string per turn: a user prompt and everything up to the next prompt. */
  turns: string[];
  /** Indices of turns that start a new work period (after an idle gap); always starts with 0. */
  segmentStarts: number[];
}

// An idle gap this long splits a session into work periods, each summarised as its own part (DECISIONS.md D28).
/** A new work period starts when a turn begins this long after the last one ended (DECISIONS.md D28). */
export const WORK_PERIOD_GAP_MS = 6 * 3_600_000;

/** Conservative: the current tokenizer averages about 2.5 characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 2.5);

function headAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} chars omitted …]\n${text.slice(text.length - tail)}`;
}

const relativeTo = (cwd: string) => (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

function entryLine(entry: DeepReadonly<TranscriptEntry>, rel: (p: string) => string): string | null {
  switch (entry.kind) {
    case 'user':
      return `USER: ${headAndTail(entry.text, MAX_PROMPT_CHARS)}`;
    case 'assistant':
      return `ASSISTANT: ${headAndTail(entry.text, MAX_REPLY_CHARS)}`;
    case 'interruption':
      return '[user interrupted]';
    case 'tool': {
      const status =
        entry.status === 'rejected' ? ' (rejected by user)' : entry.exitCode !== null && SHELL_TOOLS.has(entry.name) ? ` (exit ${entry.exitCode})` : entry.status === 'error' ? ' (failed)' : '';
      // Shell calls show the command's first line (already redacted), so the summariser can see tests, installs and commits.
      if (SHELL_TOOLS.has(entry.name)) return `TOOL ${entry.name}: ${commandLine(entry.input)}${status}`;
      const paths = entry.filePaths.map(rel).join(', ');
      return `TOOL ${entry.name}${paths ? ` ${paths}` : ''}${status}`;
    }
    case 'reasoning':
      return null;
  }
}

function metadataFor(s: DeepReadonly<ParsedSession>, rel: (p: string) => string, workPeriods: number): string {
  const files = s.filesTouched.map(rel);
  const listed = files.slice(0, MAX_FILES_LISTED).join(', ') + (files.length > MAX_FILES_LISTED ? `, … and ${files.length - MAX_FILES_LISTED} more` : '');
  const otherBranches = s.gitBranches.filter((b) => b !== s.gitBranch);
  const lines = [
    `Agent: ${s.agent}`,
    `Branch: ${s.gitBranch ?? 'unknown'}${otherBranches.length ? ` (also: ${otherBranches.join(', ')})` : ''}`,
    `Started: ${s.startedAt}; ended: ${s.endedAt}`,
    ...(workPeriods > 1 ? [`Work periods: ${workPeriods} (separated by gaps of 6+ hours)`] : []),
    `Prompts: ${s.turnCount}; tool calls: ${s.toolCallCount}`,
    `Files changed (${files.length}): ${listed || 'none'}`,
    ...(s.commitShas.length ? [`Commits made during the session: ${s.commitShas.length}`] : []),
    ...s.subagents.map((a) => {
      const report = headAndTail(a.finalText ?? 'no report', MAX_SUBAGENT_CHARS);
      const changed = a.filesTouched.length ? ` Files: ${a.filesTouched.map(rel).join(', ')}` : '';
      return `SUBAGENT ${a.agentType ?? 'agent'} "${a.description ?? 'no description'}": ${report}${changed}`;
    }),
  ];
  return lines.join('\n');
}

export function condenseSession(redacted: RedactedSession): CondensedSession {
  assertRedactedSession(redacted);
  const s = redacted.session;
  const rel = relativeTo(s.cwd);

  const turns: string[][] = [];
  const spans: { first: number; last: number }[] = [];
  let repeat = { line: '', count: 0 };
  const flush = () => {
    if (repeat.count) turns.at(-1)!.push(repeat.count > 1 ? `${repeat.line} ×${repeat.count}` : repeat.line);
    repeat = { line: '', count: 0 };
  };

  for (const entry of s.transcript) {
    const line = entryLine(entry, rel);
    if (line === null) continue;
    if (entry.kind === 'user' || turns.length === 0) {
      flush();
      turns.push([]);
      spans.push({ first: Date.parse(entry.timestamp), last: Date.parse(entry.timestamp) });
    }
    spans.at(-1)!.last = Math.max(spans.at(-1)!.last, Date.parse(entry.timestamp));
    if (entry.kind === 'tool' && line === repeat.line) {
      repeat.count++;
      continue;
    }
    flush();
    if (entry.kind === 'tool') repeat = { line, count: 1 };
    else turns.at(-1)!.push(line);
  }
  flush();

  const segmentStarts = [0];
  const texts = turns.map((t, i) => {
    const gap = i > 0 ? spans[i]!.first - spans[i - 1]!.last : 0;
    if (gap < WORK_PERIOD_GAP_MS) return t.join('\n');
    segmentStarts.push(i);
    return [`[resumed after ${Math.round(gap / 3_600_000)} hours]`, ...t].join('\n');
  });
  return { metadata: metadataFor(s, rel, segmentStarts.length), turns: texts, segmentStarts };
}

export interface Chunk {
  text: string;
  /** 1-based work period the chunk belongs to. */
  period: number;
}

/**
 * Packs whole turns into chunks of at most `budgetTokens`, never across a work-period boundary;
 * a turn larger than the budget is split by line.
 */
export function chunkSession(turns: string[], budgetTokens: number, segmentStarts: number[] = [0]): Chunk[] {
  const maxChars = Math.floor(budgetTokens * 2.5);
  const periodOf = (turn: number) => segmentStarts.filter((start) => start <= turn).length;
  const pieces = turns.flatMap((turn, i) => {
    const lines = estimateTokens(turn) <= budgetTokens ? [turn] : turn.split('\n').flatMap((line) => (line.length <= maxChars ? [line] : (line.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) ?? [])));
    return lines.map((text) => ({ text, period: Math.max(1, periodOf(i)) }));
  });

  const chunks: Chunk[] = [];
  for (const { text, period } of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.period === period && estimateTokens(`${last.text}\n${text}`) <= budgetTokens) last.text = `${last.text}\n${text}`;
    else chunks.push({ text, period });
  }
  return chunks;
}

export const chunkTurns = (turns: string[], budgetTokens: number, segmentStarts: number[] = [0]): string[] =>
  chunkSession(turns, budgetTokens, segmentStarts).map((c) => c.text);
