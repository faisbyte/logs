import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import type { ParsedSession, ToolEntry } from '../../src/schema.js';
import { claude } from '../fixtures.js';

export const base = parseClaudeCodeFile(claude.messy)!;

/** The same text in every free-text field of a session. */
export function sessionWith(text: string): ParsedSession {
  const tool: ToolEntry = {
    kind: 'tool',
    timestamp: base.startedAt,
    callId: text,
    name: text,
    input: text,
    filePaths: [text],
    output: text,
    outputTruncated: false,
    status: 'ok',
    exitCode: null,
  };
  return {
    ...base,
    sourceSessionId: text,
    sourcePath: text,
    agentVersions: [text],
    title: text,
    cwd: text,
    gitBranch: text,
    gitBranches: [text],
    models: [text],
    filesTouched: [text],
    commitShas: [text],
    subagents: [{ agentType: text, description: text, prompt: text, finalText: text, filesTouched: [text], toolCallCount: 1 }],
    transcript: [
      { kind: 'user', timestamp: base.startedAt, text },
      { kind: 'assistant', timestamp: base.startedAt, text },
      { kind: 'reasoning', timestamp: base.startedAt, text },
      tool,
      { kind: 'interruption', timestamp: base.startedAt },
    ],
  };
}
