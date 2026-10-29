import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { estimateCostUsd, summarizeSettings } from '../../src/summarize/settings.js';

function repoWithConfig(contents: object) {
  const repo = mkdtempSync(join(tmpdir(), 'digest-sumcfg-'));
  mkdirSync(join(repo, '.digest'));
  writeFileSync(join(repo, '.digest/config.json'), JSON.stringify(contents));
  return repo;
}

describe('summarize settings', () => {
  it('defaults to the fast, cheap Haiku model at low effort, in chunks small enough that no part dominates the summary', () => {
    expect(summarizeSettings(readConfig(mkdtempSync(join(tmpdir(), 'digest-nocfg-'))))).toEqual({
      model: 'claude-haiku-5-5',
      effort: 'low',
      chunkTokens: 15_000,
    });
  });

  it('reads model, effort and chunk size from .digest/config.json', () => {
    const repo = repoWithConfig({ summarize: { model: 'claude-sonnet-5-5', effort: 'medium', chunkTokens: 20_000 } });
    expect(summarizeSettings(readConfig(repo))).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium', chunkTokens: 20_000 });
  });

  it('rejects unknown keys and nonsense values', () => {
    expect(() => readConfig(repoWithConfig({ summarize: { modle: 'x' } }))).toThrow(/\.digest\/config\.json/);
    expect(() => readConfig(repoWithConfig({ summarize: { effort: 'extreme' } }))).toThrow(/\.digest\/config\.json/);
    expect(() => readConfig(repoWithConfig({ summarize: { chunkTokens: 10 } }))).toThrow(/\.digest\/config\.json/);
  });
});

describe('estimateCostUsd', () => {
  it('prices Haiku 5.5 at $0.10 / $0.50 per MTok for prompts up to 100K tokens', () => {
    expect(estimateCostUsd('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 1_000_000 })).toBeCloseTo(0.51);
    expect(estimateCostUsd('claude-haiku-5-5', { inputTokens: 50_000, outputTokens: 2_000 })).toBeCloseTo(0.006);
  });

  it('switches to $0.50 / $2.50 when one request prompt is over 100K tokens', () => {
    expect(estimateCostUsd('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 1_000 })).toBeCloseTo(0.1025);
  });

  it('knows the other current models and returns null for unknown ones', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2);
    expect(estimateCostUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(20);
    expect(estimateCostUsd('some-future-model', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});
