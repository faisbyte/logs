import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../src/parsers/claude-code.js';
import { parseCodexFile } from '../src/parsers/codex.js';
import { ParsedSessionSchema, type ParsedSession, type ToolEntry } from '../src/schema.js';
import { truncateToolOutputs } from '../src/truncate.js';
import { claude, codex } from './fixtures.js';

const tools = (s: ParsedSession) => s.transcript.filter((e): e is ToolEntry => e.kind === 'tool');

function sessionWithTool(tool: Partial<ToolEntry>): ParsedSession {
  const base = parseClaudeCodeFile(claude.basic)!;
  const entry: ToolEntry = {
    kind: 'tool',
    timestamp: base.startedAt,
    callId: 't1',
    name: 'Bash',
    input: 'pnpm test',
    filePaths: [],
    output: 'ok',
    outputTruncated: false,
    status: 'ok',
    exitCode: null,
    ...tool,
  };
  return { ...base, transcript: [entry] };
}

describe('truncateToolOutputs', () => {
  const long = parseClaudeCodeFile(claude.long)!;
  const condensed = truncateToolOutputs(long, { maxOutputChars: 2000 });

  it('keeps every tool output within the limit, plus a short marker', () => {
    const before = Math.max(...tools(long).map((t) => t.output?.length ?? 0));
    const after = Math.max(...tools(condensed).map((t) => t.output?.length ?? 0));
    expect(before).toBeGreaterThan(50_000);
    expect(after).toBeLessThanOrEqual(2100);
  });

  it('strips file dumps from Read results entirely', () => {
    for (const read of tools(condensed).filter((t) => t.name === 'Read')) {
      expect(read).toMatchObject({ output: null, outputTruncated: true });
    }
  });

  it('keeps the head and tail of long command output and says how much was cut', () => {
    const output = `HEAD ${'x'.repeat(10_000)} TAIL`;
    const [tool] = tools(truncateToolOutputs(sessionWithTool({ output }), { maxOutputChars: 100 }));
    expect(tool!.output).toMatch(/^HEAD /);
    expect(tool!.output).toMatch(/ TAIL$/);
    expect(tool!.output).toContain('[… 9910 chars truncated …]');
    expect(tool!.outputTruncated).toBe(true);
  });

  it('leaves short outputs alone', () => {
    const [tool] = tools(truncateToolOutputs(sessionWithTool({ output: 'all good' }), { maxOutputChars: 100 }));
    expect(tool).toMatchObject({ output: 'all good', outputTruncated: false });
  });

  it('caps very long tool inputs such as multi-line scripts', () => {
    const [tool] = tools(truncateToolOutputs(sessionWithTool({ input: 'y'.repeat(5000) }), { maxInputChars: 200 }));
    expect(tool!.input.length).toBeLessThanOrEqual(201);
    expect(tool!.input.endsWith('…')).toBe(true);
  });

  it('keeps prompts, assistant text, reasoning, tool names and file paths unchanged', () => {
    const messy = parseClaudeCodeFile(claude.messy)!;
    const out = truncateToolOutputs(messy, { maxOutputChars: 10 });
    expect(out.transcript.filter((e) => e.kind !== 'tool')).toEqual(messy.transcript.filter((e) => e.kind !== 'tool'));
    expect(tools(out).map((t) => [t.name, t.filePaths])).toEqual(tools(messy).map((t) => [t.name, t.filePaths]));
  });

  it('does not modify the session it was given', () => {
    const fresh = parseCodexFile(codex.long)!;
    const copy = structuredClone(fresh);
    truncateToolOutputs(fresh, { maxOutputChars: 10 });
    expect(fresh).toEqual(copy);
  });

  it('produces a schema-valid session with default limits', () => {
    expect(ParsedSessionSchema.safeParse(truncateToolOutputs(long)).success).toBe(true);
  });
});
