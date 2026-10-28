import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession, type RedactedSession } from '../../src/redact/session.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import type { LlmRequest } from '../../src/summarize/llm.js';
import { LlmSummarySchema } from '../../src/summarize/schema.js';
import { claude } from '../fixtures.js';

const parsed = parseClaudeCodeFile(claude.basic)!;
const request = (source: RedactedSession, content = 'Summarise this.'): LlmRequest => ({
  source,
  system: 'You summarise sessions.',
  messages: [{ role: 'user', content }],
  schema: LlmSummarySchema,
  maxTokens: 1000,
});

describe('FakeLlmClient', () => {
  it('answers from its script in order and records each request', async () => {
    const llm = new FakeLlmClient(['{"a":1}', '{"b":2}']);
    const source = redactSession(parsed);
    expect((await llm.complete(request(source))).text).toBe('{"a":1}');
    expect((await llm.complete(request(source, 'Again.'))).text).toBe('{"b":2}');
    expect(llm.requests.map((r) => r.messages.at(-1)?.content)).toEqual(['Summarise this.', 'Again.']);
  });

  it('can answer from a function of the request', async () => {
    const llm = new FakeLlmClient((req) => `echo: ${req.messages.length}`);
    expect((await llm.complete(request(redactSession(parsed)))).text).toBe('echo: 1');
  });

  it('estimates token usage from the prompt and the reply', async () => {
    const llm = new FakeLlmClient(['x'.repeat(250)]);
    const { usage } = await llm.complete(request(redactSession(parsed), 'y'.repeat(1000)));
    expect(usage.outputTokens).toBe(100);
    expect(usage.inputTokens).toBeGreaterThanOrEqual(400);
  });

  it('fails when its script runs out', async () => {
    await expect(new FakeLlmClient([]).complete(request(redactSession(parsed)))).rejects.toThrow(/script/);
  });

  it('refuses a request whose source is not a real RedactedSession, before answering', async () => {
    const llm = new FakeLlmClient(['{}']);
    const forged = [parsed, { ...redactSession(parsed) }, { session: parsed, counts: {} }] as unknown as RedactedSession[];
    for (const source of forged) await expect(llm.complete(request(source))).rejects.toThrow(/unredacted/);
    expect(llm.requests).toEqual([]);
  });
});
