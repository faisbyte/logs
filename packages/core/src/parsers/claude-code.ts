import { readFileSync } from 'node:fs';
import type { ParsedSession } from '../schema.js';

interface ClaudeEvent {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  aiTitle?: string;
  message?: { model?: string };
}

const distinct = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];

export function parseClaudeCodeFile(path: string): ParsedSession | null {
  const events = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ClaudeEvent);

  const cwd = events.find((e) => e.cwd)?.cwd;
  const sessionId = events.find((e) => e.sessionId)?.sessionId;
  if (!cwd || !sessionId) return null;

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
    turnCount: 0,
    toolCallCount: 0,
    filesTouched: [],
    commitShas: [],
    transcript: [],
  };
}
