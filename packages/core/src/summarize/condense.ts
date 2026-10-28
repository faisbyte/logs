import { assertRedactedSession, type DeepReadonly, type RedactedSession } from '../redact/session.js';
import type { ParsedSession, TranscriptEntry } from '../schema.js';

// What the summariser sees (DECISIONS.md D22): user prompts, assistant text, tool names and paths,
// plus markers for rejected/failed tools and interruptions. No reasoning, no tool output.

const MAX_PROMPT_CHARS = 4_000;
const MAX_REPLY_CHARS = 2_000;
const MAX_SUBAGENT_CHARS = 300;
const MAX_FILES_LISTED = 50;

export interface CondensedSession {
  /** Session facts and subagents; sent with every chunk. */
  metadata: string;
  /** One string per turn: a user prompt and everything up to the next prompt. */
  turns: string[];
}

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
      const paths = entry.filePaths.map(rel).join(', ');
      const status = entry.status === 'rejected' ? ' (rejected by user)' : entry.status === 'error' ? ' (failed)' : '';
      return `TOOL ${entry.name}${paths ? ` ${paths}` : ''}${status}`;
    }
    case 'reasoning':
      return null;
  }
}

function metadataFor(s: DeepReadonly<ParsedSession>, rel: (p: string) => string): string {
  const files = s.filesTouched.map(rel);
  const listed = files.slice(0, MAX_FILES_LISTED).join(', ') + (files.length > MAX_FILES_LISTED ? `, … and ${files.length - MAX_FILES_LISTED} more` : '');
  const otherBranches = s.gitBranches.filter((b) => b !== s.gitBranch);
  const lines = [
    `Agent: ${s.agent}`,
    `Branch: ${s.gitBranch ?? 'unknown'}${otherBranches.length ? ` (also: ${otherBranches.join(', ')})` : ''}`,
    `Started: ${s.startedAt}; ended: ${s.endedAt}`,
    `Prompts: ${s.turnCount}; tool calls: ${s.toolCallCount}`,
    `Files changed (${files.length}): ${listed || 'none'}`,
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
    }
    if (entry.kind === 'tool' && line === repeat.line) {
      repeat.count++;
      continue;
    }
    flush();
    if (entry.kind === 'tool') repeat = { line, count: 1 };
    else turns.at(-1)!.push(line);
  }
  flush();

  return { metadata: metadataFor(s, rel), turns: turns.map((t) => t.join('\n')) };
}

/** Packs whole turns into chunks of at most `budgetTokens`; a turn larger than the budget is split by line. */
export function chunkTurns(turns: string[], budgetTokens: number): string[] {
  const maxChars = Math.floor(budgetTokens * 2.5);
  const pieces = turns.flatMap((turn) => {
    if (estimateTokens(turn) <= budgetTokens) return [turn];
    return turn.split('\n').flatMap((line) => (line.length <= maxChars ? [line] : (line.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) ?? [])));
  });

  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && estimateTokens(`${last}\n${piece}`) <= budgetTokens) chunks[chunks.length - 1] = `${last}\n${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}
