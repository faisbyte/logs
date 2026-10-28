import { describe, expect, it } from 'vitest';
import { isEmptySession } from '../src/empty.js';
import { parseClaudeCodeFile } from '../src/parsers/claude-code.js';
import { parseCodexFile } from '../src/parsers/codex.js';
import { claude, codex } from './fixtures.js';

describe('isEmptySession', () => {
  it('is true for a session with a prompt but no reply, reasoning or tool call', () => {
    expect(isEmptySession(parseCodexFile(codex.empty)!)).toBe(true);
  });

  it('is false for sessions with any assistant activity', () => {
    for (const file of [...Object.values(claude), codex.basic, codex.long, codex.messy]) {
      const session = parseClaudeCodeFile(file) ?? parseCodexFile(file);
      expect(isEmptySession(session!)).toBe(false);
    }
  });

  it('counts subagent tool calls as activity', () => {
    const basic = parseClaudeCodeFile(claude.basic)!;
    expect(isEmptySession({ ...basic, transcript: basic.transcript.filter((e) => e.kind === 'user'), toolCallCount: 2 })).toBe(false);
  });
});
