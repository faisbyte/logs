import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedSession, ToolEntry, TranscriptEntry } from '../schema.js';
import { distinct, readJsonl } from './jsonl.js';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

interface ClaudeEvent {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  aiTitle?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  message?: { model?: string; content?: string | ContentBlock[] };
}

// Text that Claude Code injects into user events; none of it was typed as a prompt.
const INJECTED_TAG =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-input|bash-stdout|bash-stderr|system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>/;
const INTERRUPTION = /^\[Request interrupted by user/;
const REJECTION = /^The user doesn't want to proceed with this tool use/;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function userEntry(event: ClaudeEvent): TranscriptEntry | null {
  if (event.isMeta || event.isCompactSummary) return null;
  if (event.origin?.kind && event.origin.kind !== 'human') return null;

  const content = event.message?.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : (content ?? []).filter((b) => b.type === 'text' && b.text !== undefined).map((b) => b.text!);
  const typed = texts.filter((t) => !INJECTED_TAG.test(t));
  if (typed.length === 0) return null;

  const timestamp = event.timestamp!;
  if (typed.every((t) => INTERRUPTION.test(t))) return { kind: 'interruption', timestamp };
  return { kind: 'user', timestamp, text: typed.join('\n') };
}

function summariseInput(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  switch (name) {
    case 'Bash':
      return str('command') ?? '';
    case 'Agent':
    case 'Task':
      return `${str('subagent_type') ?? 'agent'}: ${str('description') ?? ''}`;
    default:
      return str('file_path') ?? str('notebook_path') ?? JSON.stringify(input);
  }
}

function referencedPaths(input: Record<string, unknown>): string[] {
  return [input.file_path, input.notebook_path].filter((p): p is string => typeof p === 'string');
}

function resultText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : undefined))
    .filter((t): t is string => t !== undefined)
    .join('\n');
}

function parseEvents(events: ClaudeEvent[]): { transcript: TranscriptEntry[]; tools: ToolEntry[] } {
  const transcript: TranscriptEntry[] = [];
  const toolsById = new Map<string, ToolEntry>();
  for (const event of events) {
    const timestamp = event.timestamp!;
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];

    if (event.type === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'text' && block.text?.trim()) transcript.push({ kind: 'assistant', timestamp, text: block.text });
        if (block.type === 'thinking' && block.thinking?.trim()) transcript.push({ kind: 'reasoning', timestamp, text: block.thinking });
        if (block.type === 'tool_use' && block.id && block.name) {
          const input = block.input ?? {};
          const entry: ToolEntry = {
            kind: 'tool',
            timestamp,
            callId: block.id,
            name: block.name,
            input: summariseInput(block.name, input),
            filePaths: referencedPaths(input),
            output: null,
            outputTruncated: false,
            status: 'unknown',
          };
          toolsById.set(block.id, entry);
          transcript.push(entry);
        }
      }
    }

    if (event.type === 'user') {
      for (const block of blocks) {
        const entry = block.type === 'tool_result' && block.tool_use_id ? toolsById.get(block.tool_use_id) : undefined;
        if (!entry) continue;
        entry.output = resultText(block.content);
        entry.status = !block.is_error ? 'ok' : REJECTION.test(entry.output) ? 'rejected' : 'error';
      }
      const entry = userEntry(event);
      if (entry) transcript.push(entry);
    }
  }
  return { transcript, tools: [...toolsById.values()] };
}

/** Subagent transcripts live next to the main file: <session>/subagents/agent-*.jsonl. */
function subagentTools(path: string): ToolEntry[] {
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => parseEvents(readJsonl<ClaudeEvent>(join(dir, f))).tools);
}

export function parseClaudeCodeFile(path: string): ParsedSession | null {
  const events = readJsonl<ClaudeEvent>(path);

  const cwd = events.find((e) => e.cwd)?.cwd;
  const sessionId = events.find((e) => e.sessionId)?.sessionId;
  if (!cwd || !sessionId) return null;

  const { transcript, tools } = parseEvents(events);
  const allTools = [...tools, ...subagentTools(path)];
  const edits = allTools.filter((t) => EDIT_TOOLS.has(t.name) && t.status === 'ok');
  const filesTouched = distinct(edits.flatMap((t) => t.filePaths)).sort();

  const times = events.map((e) => e.timestamp).filter((t): t is string => !!t).sort();
  const branches = distinct(events.map((e) => e.gitBranch));
  const titles = events.filter((e) => e.type === 'ai-title' && e.aiTitle);

  return {
    agent: 'claude-code',
    sourceSessionId: sessionId,
    sourcePath: path,
    agentVersions: distinct(events.map((e) => e.version)),
    title: titles.at(-1)?.aiTitle ?? null,
    cwd,
    gitBranch: branches[0] ?? null,
    gitBranches: branches,
    startedAt: times[0]!,
    endedAt: times.at(-1)!,
    models: distinct(events.filter((e) => e.type === 'assistant').map((e) => e.message?.model)),
    turnCount: transcript.filter((e) => e.kind === 'user').length,
    toolCallCount: allTools.length,
    filesTouched,
    commitShas: [],
    transcript,
  };
}
