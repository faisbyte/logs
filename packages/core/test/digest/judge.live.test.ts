// Opt-in digest eval (DECISIONS.md D56): real models against the golden sprint. Runs only with DIGEST_EVAL=1 and
// ANTHROPIC_API_KEY set, and costs money.
//   DIGEST_EVAL=1 pnpm exec vitest run packages/core/test/digest/judge.live.test.ts
// DIGEST_EVAL_MODEL overrides the digest writer (default claude-sonnet-5-5); DIGEST_JUDGE_MODEL the judge (same default).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateDigest } from '../../src/digest/generate.js';
import { digestInput } from '../../src/digest/input.js';
import { judgeDigest } from '../../src/digest/judge.js';
import { ensureDigestDir } from '../../src/digest-dir.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { ticketReport } from '../../src/shared/ticket-report.js';
import { AnthropicLlmClient } from '../../src/summarize/anthropic-llm.js';
import { payloadFor } from '../shared/store-contract.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const golden = JSON.parse(readFileSync(new URL('./golden-sprint.json', import.meta.url), 'utf8'));
const REPO = 'github.com/acme/eval';

async function goldenInput() {
  const store = new InMemorySummaryStore();
  await store.saveSprint(REPO, golden.sprint);
  await store.saveTrackerTickets(REPO, golden.titles.map((t: { key: string; title: string }) => ({ ...t, sprint: golden.sprint.name })));
  for (const { developer, ...s } of golden.summaries) await store.push({ repoId: REPO, developerId: developer, developerName: developer }, payloadFor(s));
  return digestInput(await ticketReport(store, REPO, { sprint: golden.sprint.name }));
}

const flagged = (claims: { claim: string }[], phrase: string) => claims.some((c) => c.claim.toLowerCase().includes(phrase.toLowerCase()));

describe.skipIf(!process.env.DIGEST_EVAL || !process.env.ANTHROPIC_API_KEY)('live digest eval against the golden sprint', () => {
  it('the judge flags the planted unsupported claims, and a freshly written digest is checked too', async () => {
    const input = await goldenInput();
    const judge = AnthropicLlmClient.fromEnv(process.env, process.env.DIGEST_JUDGE_MODEL ?? 'claude-sonnet-5-5', 'medium');
    const planted = await judgeDigest(input, golden.plantedDigest, judge);
    const writer = AnthropicLlmClient.fromEnv(process.env, process.env.DIGEST_EVAL_MODEL ?? 'claude-sonnet-5-5', 'medium');
    const digest = await generateDigest(input, writer);
    const fresh = await judgeDigest(input, digest.markdown, judge);

    const cost = [planted.usage.costUsd, digest.usage.costUsd, fresh.usage.costUsd].reduce<number>((n, c) => n + (c ?? 0), 0);
    const lines = [
      `# Digest eval: writer ${writer.model}, judge ${judge.model}, ${new Date().toISOString()}`,
      '',
      `Planted digest: ${planted.claimCount} claims, ${planted.unsupported.length} unsupported.`,
      ...golden.mustFlag.map((p: string) => `- must flag "${p}": ${flagged(planted.unsupported, p) ? 'flagged' : 'MISSED'}`),
      ...golden.mustNotFlag.map((p: string) => `- must not flag "${p}": ${flagged(planted.unsupported, p) ? 'WRONGLY FLAGGED' : 'ok'}`),
      '',
      `Fresh digest: ${fresh.claimCount} claims, ${fresh.unsupported.length} unsupported.`,
      ...fresh.unsupported.map((u) => `- ${u.claim} (${u.reason})`),
      '',
      `Cost: $${cost.toFixed(4)}`,
      '',
      '## Fresh digest',
      '',
      digest.markdown,
    ];
    writeFileSync(join(ensureDigestDir(REPO_ROOT, 'eval'), `digest-report-${Date.now()}.md`), `${lines.join('\n')}\n`);

    for (const phrase of golden.mustFlag) expect(flagged(planted.unsupported, phrase), `should flag "${phrase}"`).toBe(true);
    for (const phrase of golden.mustNotFlag) expect(flagged(planted.unsupported, phrase), `should not flag "${phrase}"`).toBe(false);
  }, 300_000);
});
