import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { parseCodexFile } from '../../src/parsers/codex.js';
import { redactSession, type RedactedSession } from '../../src/redact/session.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { PROMPT_VERSION } from '../../src/summarize/prompt.js';
import { summarizeSession } from '../../src/summarize/summarize.js';
import { claude, codex } from '../fixtures.js';
import { llmSummary } from './helpers.js';

const redacted = (file: string) => redactSession((parseClaudeCodeFile(file) ?? parseCodexFile(file))!, { home: false });
const json = (o: object) => JSON.stringify(o);
const options = { chunkTokens: 60_000, now: () => new Date('2026-10-28T10:00:00.000Z') };

describe('summarizeSession (one chunk)', () => {
  it('sends system prompt, metadata and condensed transcript, and builds a draft summary', async () => {
    const llm = new FakeLlmClient([json(llmSummary())], 'claude-haiku-5-5');
    const summary = await summarizeSession(redacted(claude.basic), llm, options);

    const [request] = llm.requests;
    expect(request!.system).toContain('You are summarising one AI coding session for a team log.');
    expect(request!.messages[0]!.content).toContain('Branch: feature/PROJ-142-rate-limit');
    expect(request!.messages[0]!.content).toContain('TOOL Write src/middleware/rateLimit.ts');
    expect(summary).toMatchObject({
      status: 'draft',
      goal: 'Rate limit the login endpoint.',
      filesTouched: ['src/middleware/rateLimit.ts', 'src/routes/login.ts'],
      ticketRefs: ['PROJ-142'],
      promptVersion: PROMPT_VERSION,
      model: 'claude-haiku-5-5',
      generatedAt: '2026-10-28T10:00:00.000Z',
    });
    expect(summary.usage.requests).toBe(1);
    expect(summary.usage.costUsd).toBeGreaterThan(0);
  });

  it('retries once with the validation error and the previous reply', async () => {
    const llm = new FakeLlmClient(['not json at all', json(llmSummary())]);
    const summary = await summarizeSession(redacted(claude.basic), llm, options);
    expect(summary.goal).toBe('Rate limit the login endpoint.');
    const retry = llm.requests[1]!;
    expect(retry.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(retry.messages[1]!.content).toBe('not json at all');
    expect(retry.messages[2]!.content).toMatch(/not valid JSON/);
    expect(summary.usage.requests).toBe(2);
  });

  it('names schema violations in the retry', async () => {
    const { outcome: _missing, ...noOutcome } = llmSummary();
    const llm = new FakeLlmClient([json(noOutcome), json(llmSummary())]);
    await summarizeSession(redacted(claude.basic), llm, options);
    expect(llm.requests[1]!.messages[2]!.content).toContain('outcome');
  });

  it('retries when the post-check finds a code block or a placeholder', async () => {
    const llm = new FakeLlmClient([json(llmSummary({ whatWasDone: 'Ran ```pnpm test```' })), json(llmSummary())]);
    await summarizeSession(redacted(claude.basic), llm, options);
    expect(llm.requests[1]!.messages[2]!.content).toContain('whatWasDone contains a code block');
  });

  it('treats a reply cut off at max_tokens as invalid', async () => {
    const llm = new FakeLlmClient([{ text: '{"goal": "Rate li', stopReason: 'max_tokens' }, json(llmSummary())]);
    await summarizeSession(redacted(claude.basic), llm, options);
    expect(llm.requests[1]!.messages[2]!.content).toMatch(/cut off/);
  });

  it('fails with a clear message after a second invalid reply', async () => {
    const llm = new FakeLlmClient(['nope', 'still nope']);
    await expect(summarizeSession(redacted(claude.basic), llm, options)).rejects.toThrow(
      /Summary for c1a5e001-0000-4000-8000-000000000001 failed validation twice: .*not valid JSON/,
    );
  });

  it('fails without retrying when the model refuses', async () => {
    const llm = new FakeLlmClient([{ text: '', stopReason: 'refusal' }, json(llmSummary())]);
    await expect(summarizeSession(redacted(claude.basic), llm, options)).rejects.toThrow(/refused/);
    expect(llm.requests).toHaveLength(1);
  });

  it('refuses empty sessions and anything that is not a RedactedSession', async () => {
    const llm = new FakeLlmClient([json(llmSummary())]);
    await expect(summarizeSession(redacted(codex.empty), llm, options)).rejects.toThrow(/empty/);
    const raw = parseClaudeCodeFile(claude.basic)! as unknown as RedactedSession;
    await expect(summarizeSession(raw, llm, options)).rejects.toThrow(/unredacted/);
    expect(llm.requests).toEqual([]);
  });

  it('reports unknown cost for a model without a price', async () => {
    const summary = await summarizeSession(redacted(claude.basic), new FakeLlmClient([json(llmSummary())], 'mystery-model'), options);
    expect(summary.usage.costUsd).toBeNull();
  });
});
