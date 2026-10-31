// Opt-in context-extraction eval (DECISIONS.md D79): a real model against the golden context fixture, in two runs
// so the second has to supersede an item from the first. Runs only with CONTEXT_EVAL=1 and ANTHROPIC_API_KEY set,
// and costs money.
//   CONTEXT_EVAL=1 pnpm exec vitest run packages/core/test/context/extract.live.test.ts
// CONTEXT_EVAL_MODEL overrides the model (default claude-sonnet-5-5).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contextInput, extractContext } from '../../src/context/extract.js';
import { ensureDigestDir } from '../../src/digest-dir.js';
import { AnthropicLlmClient } from '../../src/summarize/anthropic-llm.js';
import { GOLDEN_REPO, goldenFailures, goldenSummaries } from './golden.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe.skipIf(!process.env.CONTEXT_EVAL || !process.env.ANTHROPIC_API_KEY)('live context extraction eval against the golden fixture', () => {
  it('keeps the decision and the pitfall, supersedes the old lockout, and skips temporary and injected items', async () => {
    const llm = AnthropicLlmClient.fromEnv(process.env, process.env.CONTEXT_EVAL_MODEL ?? 'claude-sonnet-5-5', 'medium');
    const { store, first, rest } = await goldenSummaries();
    const one = await extractContext(contextInput(first), llm);
    await store.applyContextChanges(GOLDEN_REPO, one.changes);
    const two = await extractContext(contextInput(rest, await store.contextItems(GOLDEN_REPO)), llm);
    await store.applyContextChanges(GOLDEN_REPO, two.changes);
    const items = await store.contextItems(GOLDEN_REPO);
    const failures = goldenFailures(items);

    const cost = [one, two].reduce<number>((n, r) => n + (r.usage.costUsd ?? 0), 0);
    const lines = [
      `# Context eval: ${llm.model}, ${new Date().toISOString()}`,
      '',
      `Run 1: ${one.changes.added.length} added${one.retried ? ', retried once' : ''}${one.dropped.length ? `; dropped: ${one.dropped.join('; ')}` : ''}.`,
      `Run 2: ${two.changes.added.length} added, ${two.changes.merged.length} merged, ${two.changes.superseded.length} superseded${two.retried ? ', retried once' : ''}${two.dropped.length ? `; dropped: ${two.dropped.join('; ')}` : ''}.`,
      '',
      failures.length ? `Failures:\n${failures.map((f) => `- ${f}`).join('\n')}` : 'All checks passed.',
      '',
      `Cost: $${cost.toFixed(4)}`,
      '',
      '## Items',
      '',
      ...items.map((i) => `- [${i.status}${i.supersededBy ? ` by ${i.supersededBy}` : ''}] ${i.id} ${i.type}: ${i.text} Why: ${i.reason} (${i.paths.join(', ') || 'no paths'})`),
    ];
    writeFileSync(join(ensureDigestDir(REPO_ROOT, 'eval'), `context-eval-${Date.now()}.md`), `${lines.join('\n')}\n`);
    expect(failures).toEqual([]);
  }, 300_000);
});
