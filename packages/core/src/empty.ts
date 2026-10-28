import type { ParsedSession } from './schema.js';

/** A prompt (or nothing) with no reply, reasoning or tool call, e.g. Codex VS Code exec twins (DECISIONS.md D18). */
export const isEmptySession = (s: ParsedSession) => s.toolCallCount === 0 && !s.transcript.some((e) => e.kind === 'assistant' || e.kind === 'reasoning' || e.kind === 'tool');
