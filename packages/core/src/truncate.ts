import type { ParsedSession, TranscriptEntry } from './schema.js';

export interface TruncateLimits {
  /** Longest tool output kept; longer output keeps its head and tail. */
  maxOutputChars?: number;
  /** Longest tool input summary kept (long scripts, heredocs). */
  maxInputChars?: number;
}

// Tools whose output is a file's contents: dropped entirely rather than truncated.
const FILE_DUMP_TOOLS = new Set(['Read']);

function headAndTail(text: string, max: number): string {
  const head = Math.ceil(max / 2);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} chars truncated …]\n${text.slice(text.length - tail)}`;
}

function truncateEntry(entry: TranscriptEntry, maxOutput: number, maxInput: number): TranscriptEntry {
  if (entry.kind !== 'tool') return entry;
  const input = entry.input.length > maxInput ? `${entry.input.slice(0, maxInput)}…` : entry.input;
  if (entry.output === null) return { ...entry, input };
  if (FILE_DUMP_TOOLS.has(entry.name)) return { ...entry, input, output: null, outputTruncated: true };
  if (entry.output.length <= maxOutput) return { ...entry, input };
  return { ...entry, input, output: headAndTail(entry.output, maxOutput), outputTruncated: true };
}

/** Strips file dumps and shortens tool output so only prompts, reasoning, tool names and paths survive in full. */
export function truncateToolOutputs(session: ParsedSession, limits: TruncateLimits = {}): ParsedSession {
  const { maxOutputChars = 2000, maxInputChars = 500 } = limits;
  return {
    ...session,
    transcript: session.transcript.map((e) => truncateEntry(e, maxOutputChars, maxInputChars)),
  };
}
