import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession, type RedactedSession } from '../../src/redact/session.js';
import { AnthropicLlmClient, type MessagesApi } from '../../src/summarize/anthropic-llm.js';
import { LlmSummarySchema } from '../../src/summarize/schema.js';
import { summarizeSession } from '../../src/summarize/summarize.js';
import { claude } from '../fixtures.js';

const parsed = parseClaudeCodeFile(claude.basic)!;
const request = (source: RedactedSession) => ({
  source,
  system: 'You summarise sessions.',
  messages: [{ role: 'user' as const, content: 'Summarise this.' }],
  schema: LlmSummarySchema,
  maxTokens: 16_000,
});

/** Stands in for the SDK's messages resource: the network boundary. */
function stubApi(content: object[] = [{ type: 'text', text: '{"ok":true}' }], stop_reason = 'end_turn') {
  const calls: Record<string, unknown>[] = [];
  const api: MessagesApi = {
    async create(params) {
      calls.push(params as unknown as Record<string, unknown>);
      return { content, stop_reason, usage: { input_tokens: 1200, output_tokens: 300 } } as never;
    },
  };
  return { api, calls };
}

describe('AnthropicLlmClient', () => {
  it('sends model, system, messages, effort and a JSON-schema output format, with no sampling params or prefill', async () => {
    const { api, calls } = stubApi();
    await new AnthropicLlmClient('claude-haiku-5-5', 'low', api).complete(request(redactSession(parsed)));
    const [params] = calls;
    expect(params).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 16_000,
      system: 'You summarise sessions.',
      messages: [{ role: 'user', content: 'Summarise this.' }],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    for (const key of ['temperature', 'top_p', 'top_k']) expect(params).not.toHaveProperty(key);
    expect((params!.messages as { role: string }[]).at(-1)!.role).toBe('user');
  });

  it('returns only the text blocks, with usage and stop reason', async () => {
    const { api } = stubApi([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], 'end_turn');
    const response = await new AnthropicLlmClient('claude-haiku-5-5', 'low', api).complete(request(redactSession(parsed)));
    expect(response).toEqual({ text: '{"a":1}', usage: { inputTokens: 1200, outputTokens: 300 }, stopReason: 'end_turn' });
  });

  it('refuses an unredacted source before any network call', async () => {
    const { api, calls } = stubApi();
    const client = new AnthropicLlmClient('claude-haiku-5-5', 'low', api);
    await expect(client.complete(request(parsed as unknown as RedactedSession))).rejects.toThrow(/unredacted/);
    expect(calls).toEqual([]);
  });

  it('reads the key from ANTHROPIC_API_KEY and explains how to set it when missing', () => {
    expect(() => AnthropicLlmClient.fromEnv({}, 'claude-haiku-5-5', 'low')).toThrow(/ANTHROPIC_API_KEY/);
    expect(AnthropicLlmClient.fromEnv({ ANTHROPIC_API_KEY: 'test-key' }, 'claude-haiku-5-5', 'low').model).toBe('claude-haiku-5-5');
  });

  it('never exposes the key through serialisation or inspection', () => {
    const key = ['sk-ant-', 'not-a-real-key-', '0123456789'].join('');
    const client = AnthropicLlmClient.fromEnv({ ANTHROPIC_API_KEY: key }, 'claude-haiku-5-5', 'low');
    expect(JSON.stringify(client)).not.toContain(key);
    expect(inspect(client, { depth: 5 })).not.toContain(key);
  });
});

// Real API: runs only with DIGEST_LIVE_TESTS=1 and ANTHROPIC_API_KEY set. Costs well under a cent.
describe.skipIf(!process.env.DIGEST_LIVE_TESTS || !process.env.ANTHROPIC_API_KEY)('live API smoke test', () => {
  it('summarises the basic fixture with the default model', async () => {
    const llm = AnthropicLlmClient.fromEnv(process.env, 'claude-haiku-5-5', 'low');
    const summary = await summarizeSession(redactSession(parsed), llm, { chunkTokens: 60_000 });
    expect(summary.status).toBe('draft');
    expect(summary.goal.length).toBeGreaterThan(0);
    expect(summary.usage.inputTokens).toBeGreaterThan(0);
    const { inputTokens, outputTokens, requests, costUsd } = summary.usage;
    console.log(`smoke test: ${requests} request(s), ${inputTokens} in / ${outputTokens} out tokens, $${costUsd?.toFixed(5)}`);
  }, 120_000);
});
