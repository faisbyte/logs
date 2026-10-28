import { readFileSync } from 'node:fs';
import type { ParsedSession, TranscriptEntry } from '../schema.js';

interface ContentBlock {
  type: string;
  text?: string;
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

const distinct = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];

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

export function parseClaudeCodeFile(path: string): ParsedSession | null {
  const events = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ClaudeEvent);

  const cwd = events.find((e) => e.cwd)?.cwd;
  const sessionId = events.find((e) => e.sessionId)?.sessionId;
  if (!cwd || !sessionId) return null;

  const transcript: TranscriptEntry[] = [];
  for (const event of events) {
    if (event.type !== 'user') continue;
    const entry = userEntry(event);
    if (entry) transcript.push(entry);
  }

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
    toolCallCount: 0,
    filesTouched: [],
    commitShas: [],
    transcript,
  };
}
