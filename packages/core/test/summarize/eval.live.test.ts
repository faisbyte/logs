// Opt-in eval: real model against the goldens. Runs only with DIGEST_EVAL=1 and ANTHROPIC_API_KEY set.
//   DIGEST_EVAL=1 pnpm exec vitest run packages/core/test/summarize/eval.live.test.ts
// DIGEST_EVAL_MODEL overrides the summariser (default: the configured default model);
// DIGEST_JUDGE_MODEL overrides the judge that looks for claims not in the source (default: claude-sonnet-5-5).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ensureDigestDir } from '../../src/digest-dir.js';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { parseCodexFile } from '../../src/parsers/codex.js';
import { redactSession, type RedactedSession } from '../../src/redact/session.js';
import { AnthropicLlmClient } from '../../src/summarize/anthropic-llm.js';
import { condenseSession } from '../../src/summarize/condense.js';
import type { LlmClient } from '../../src/summarize/llm.js';
import type { SessionSummary } from '../../src/summarize/schema.js';
import { estimateSummaryCost } from '../../src/summarize/estimate.js';
import { DEFAULT_CHUNK_TOKENS, DEFAULT_MODEL, estimateCostUsd } from '../../src/summarize/settings.js';
import { summarizeSession } from '../../src/summarize/summarize.js';
import { fixtureFiles } from '../fixtures.js';
import { compareToGolden, goldens } from './compare.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const JudgeSchema = z.strictObject({ unsupportedClaims: z.array(z.string()) });
const JUDGE_PROMPT = `You check a summary of an AI coding session against the session transcript.
List every claim in the SUMMARY that the TRANSCRIPT does not support (invented facts, files, decisions or outcomes). Paraphrase is fine; only list claims with no basis in the transcript.
Return ONLY JSON: {"unsupportedClaims": ["..."]}. Return an empty list if every claim is supported.`;

let judgeCost = 0;

async function unsupportedClaims(judge: LlmClient, source: RedactedSession, summary: SessionSummary): Promise<string[]> {
  const { metadata, turns } = condenseSession(source);
  const { goal, outcome, whatWasDone, decisions, rejectedApproaches, risksOrFollowUps } = summary;
  const response = await judge.complete({
    source,
    system: JUDGE_PROMPT,
    messages: [{ role: 'user', content: `TRANSCRIPT:\n${metadata}\n${turns.join('\n')}\n\nSUMMARY:\n${JSON.stringify({ goal, outcome, whatWasDone, decisions, rejectedApproaches, risksOrFollowUps }, null, 2)}` }],
    schema: JudgeSchema,
    maxTokens: 16_000,
  });
  judgeCost += estimateCostUsd(judge.model, response.usage) ?? 0;
  return JudgeSchema.parse(JSON.parse(response.text)).unsupportedClaims;
}

describe.skipIf(!process.env.DIGEST_EVAL || !process.env.ANTHROPIC_API_KEY)('live eval against the goldens', () => {
  it('reports missing decisions, missing rejected approaches and claims not in the source', async () => {
    const model = process.env.DIGEST_EVAL_MODEL ?? DEFAULT_MODEL;
    const llm = AnthropicLlmClient.fromEnv(process.env, model, 'low');
    const judge = AnthropicLlmClient.fromEnv(process.env, process.env.DIGEST_JUDGE_MODEL ?? 'claude-sonnet-5-5', 'medium');

    const rows: string[] = [];
    let cost = 0;
    for (const golden of goldens()) {
      const parsed = (parseClaudeCodeFile(fixtureFiles[golden.fixture]!) ?? parseCodexFile(fixtureFiles[golden.fixture]!))!;
      const redacted = redactSession(parsed);
      const summary = await summarizeSession(redacted, llm, { chunkTokens: DEFAULT_CHUNK_TOKENS });
      const expected = estimateSummaryCost(redacted, { model, effort: 'low', chunkTokens: DEFAULT_CHUNK_TOKENS }).requests;
      const report = compareToGolden(summary, golden);
      const invented = await unsupportedClaims(judge, redacted, summary);
      cost += summary.usage.costUsd ?? 0;
      const list = (items: string[]) => (items.length ? items.join('; ') : '-');
      rows.push(
        `| ${golden.fixture} | ${summary.usage.requests} (${expected}) | ${summary.outcome} (golden: ${golden.outcome}) | ${list(report.missingDecisions)} | ${list(report.missingRejectedApproaches)} | ${list(report.rejectedListedAsDecision)} | ${list([...report.forbiddenMentions, ...invented])} |`,
      );
    }

    const markdown = [
      `# Summary eval: ${model} (prompt and goldens as committed), ${new Date().toISOString()}`,
      '',
      '| Fixture | Requests (expected) | Outcome | Missing decisions | Missing rejected approaches | Rejected listed as decision | Not in source |',
      '|---|---|---|---|---|---|---|',
      ...rows,
      '',
      `Summariser cost: $${cost.toFixed(4)}; judge cost: $${judgeCost.toFixed(4)}`,
    ].join('\n');
    writeFileSync(join(ensureDigestDir(REPO_ROOT, 'eval'), `report-${Date.now()}.md`), `${markdown}\n`);
    console.log(markdown);
    expect(rows).toHaveLength(goldens().length);
  }, 600_000);
});
