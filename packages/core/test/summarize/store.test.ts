import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession } from '../../src/redact/session.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { PROMPT_VERSION } from '../../src/summarize/prompt.js';
import { cacheKey, contentHash, readCachedSummary, summarizeCached, writeSummary } from '../../src/summarize/store.js';
import { summarizeSession } from '../../src/summarize/summarize.js';
import { claude } from '../fixtures.js';
import { llmSummary, pickAll } from './helpers.js';

const tempRepo = () => mkdtempSync(join(tmpdir(), 'digest-store-'));
const parsed = parseClaudeCodeFile(claude.basic)!;
const redacted = redactSession(parsed, { home: false });
const settings = { model: 'claude-haiku-5-5', effort: 'low' as const, chunkTokens: 60_000 };
const now = () => new Date('2026-10-28T10:00:00.000Z');
const reply = JSON.stringify(llmSummary());

describe('cacheKey', () => {
  const base = { sessionId: 's1', contentHash: 'h1', promptVersion: 'summarize-v1', model: 'claude-haiku-5-5' };

  it('is stable for the same inputs', () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['sessionId', 'contentHash', 'promptVersion', 'model'] as const)('changes when %s changes', (field) => {
    expect(cacheKey({ ...base, [field]: 'other' })).not.toBe(cacheKey(base));
  });
});

describe('contentHash', () => {
  it('is stable for the same session and chunk size', () => {
    expect(contentHash(redacted, 60_000)).toBe(contentHash(redactSession(parsed, { home: false }), 60_000));
  });

  it('changes when the redacted text changes, e.g. after a deny-list edit', () => {
    expect(contentHash(redactSession(parsed, { home: false, deny: ['login'] }), 60_000)).not.toBe(contentHash(redacted, 60_000));
  });

  it('changes when the chunk size changes', () => {
    expect(contentHash(redacted, 1_000)).not.toBe(contentHash(redacted, 60_000));
  });
});

describe('summary store', () => {
  it('round-trips a cached summary and treats a missing or unreadable entry as a miss', async () => {
    const repo = tempRepo();
    const summary = await summarizeSession(redacted, new FakeLlmClient([reply]), { chunkTokens: 60_000, now });
    expect(readCachedSummary(repo, 'k1')).toBeNull();
    writeSummary(repo, 'k1', summary);
    expect(readCachedSummary(repo, 'k1')).toEqual(summary);
    writeFileSync(join(repo, '.digest/cache/summaries/k2.json'), '{ broken');
    expect(readCachedSummary(repo, 'k2')).toBeNull();
  });

  it('saves the latest draft per session and keeps .digest out of git', async () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const summary = await summarizeSession(redacted, new FakeLlmClient([reply]), { chunkTokens: 60_000, now });
    writeSummary(repo, 'k1', summary);
    const draft = JSON.parse(readFileSync(join(repo, '.digest/summaries/claude-code-c1a5e001-0000-4000-8000-000000000001.json'), 'utf8'));
    expect(draft.status).toBe('draft');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
  });
});

describe('summarizeCached', () => {
  it('calls the model once, then serves the same session from the cache', async () => {
    const repo = tempRepo();
    const llm = new FakeLlmClient([reply], 'claude-haiku-5-5');
    const first = await summarizeCached(repo, redacted, llm, settings, now);
    const second = await summarizeCached(repo, redacted, llm, settings, now);
    expect(first.cached).toBe(false);
    expect(second).toEqual({ summary: first.summary, cached: true });
    expect(llm.requests).toHaveLength(1);
  });

  it('misses the cache when the model changes', async () => {
    const repo = tempRepo();
    await summarizeCached(repo, redacted, new FakeLlmClient([reply], 'claude-haiku-5-5'), settings, now);
    const other = new FakeLlmClient([reply], 'claude-sonnet-5-5');
    expect((await summarizeCached(repo, redacted, other, { ...settings, model: 'claude-sonnet-5-5' }, now)).cached).toBe(false);
    expect(other.requests).toHaveLength(1);
  });

  it('regenerates when the chunk size changes, e.g. after the default moves', async () => {
    const repo = tempRepo();
    const llm = new FakeLlmClient(() => reply, 'claude-haiku-5-5');
    await summarizeCached(repo, redacted, llm, settings, now);
    expect((await summarizeCached(repo, redacted, llm, { ...settings, chunkTokens: 15_000 }, now)).cached).toBe(false);
    expect((await summarizeCached(repo, redacted, llm, { ...settings, chunkTokens: 15_000 }, now)).cached).toBe(true);
  });

  it('logs tokens and estimated cost for each summary it generates, not for cache hits', async () => {
    const repo = tempRepo();
    const llm = new FakeLlmClient([reply], 'claude-haiku-5-5');
    await summarizeCached(repo, redacted, llm, settings, now);
    await summarizeCached(repo, redacted, llm, settings, now);
    const lines = readFileSync(join(repo, '.digest/usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sessionId: 'c1a5e001-0000-4000-8000-000000000001', model: 'claude-haiku-5-5', promptVersion: PROMPT_VERSION, requests: 1 });
    expect(lines[0].inputTokens).toBeGreaterThan(0);
    expect(lines[0].costUsd).toBeGreaterThan(0);
  });

  it('logs the validation error behind every retry', async () => {
    const repo = tempRepo();
    await summarizeCached(repo, redacted, new FakeLlmClient(['not json', reply], 'claude-haiku-5-5'), settings, now);
    const [line] = readFileSync(join(repo, '.digest/usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(line.retries).toEqual([{ call: 'part 1 of 1', errors: 'the reply was not valid JSON' }]);
  });

  it("logs each part's output and the merge's picks for a session summarised in parts", async () => {
    const repo = tempRepo();
    const long = redactSession(parseClaudeCodeFile(claude.long)!, { home: false });
    const llm = new FakeLlmClient((request) => (request.system.startsWith('You are merging') ? pickAll(request) : reply), 'claude-haiku-5-5');
    await summarizeCached(repo, long, llm, { ...settings, chunkTokens: 3_000 }, now);
    const [line] = readFileSync(join(repo, '.digest/usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(line.parts).toHaveLength(3);
    expect(line.parts[0]).toEqual({ part: 1, period: 1, output: JSON.parse(reply) });
    expect(line.merge).toMatchObject({ goal: 'Speed up search.', decisionIds: ['D1'] });
    expect(line.retries).toEqual([]);
  });

  it('does not write anything when summarising fails', async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, '.digest'));
    await expect(summarizeCached(repo, redacted, new FakeLlmClient(['bad', 'bad']), settings, now)).rejects.toThrow(/validation twice/);
    expect(existsSync(join(repo, '.digest/summaries'))).toBe(false);
    expect(existsSync(join(repo, '.digest/usage.jsonl'))).toBe(false);
  });
});
