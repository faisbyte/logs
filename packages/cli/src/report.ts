import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  AnthropicLlmClient,
  DIGEST_PROMPT_VERSION,
  digestInput,
  ensureDigestDir,
  estimateDigestCost,
  formatTime,
  generateDigest,
  periodKey,
  readConfig,
  warningText,
  type LlmClient,
} from '@digest/core';
import type { CliContext } from './cli.js';
import { connect, periodOption } from './tickets.js';

// sprintdigest report: a report written on this machine with the caller's own key, after a cost estimate, from the
// shared store's grouped summaries (DECISIONS.md D53); cached in .digest/. sprintdigest preview: what is waiting in
// developer preview (D54).

const DEFAULT_REPORT_MODEL = 'claude-sonnet-5-5';
const tokens = (n: number) => n.toLocaleString('en-US');
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface ReportOptions {
  repo?: string;
  from?: string;
  to?: string;
  sprint?: string;
  yes?: boolean;
  out?: string;
}

export async function reportCommand(options: ReportOptions, ctx: CliContext): Promise<number> {
  const c = connect('report', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const { repoRoot, target, repoId, fail } = c;
  const period = periodOption(options);
  if ('error' in period) return fail(period.error);

  let out: string | null = null;
  if (options.out !== undefined) {
    out = resolve(repoRoot, options.out);
    if (relative(repoRoot, out).startsWith('..')) return fail('--out must be a path inside the repo.');
    if (!existsSync(dirname(out)) || !statSync(dirname(out)).isDirectory()) return fail(`${relative(repoRoot, dirname(out))} does not exist; create it first.`);
  }

  const grouped = await target.tickets(repoId, period.filter);
  if (grouped.status !== 'ok') return fail(`the store refused the token: ${grouped.reason}`);
  const input = digestInput(grouped.report);
  const label = 'sprint' in period.filter ? period.filter.sprint : input.period.label;
  if (input.tickets.length === 0 && input.unlinked.length === 0) return (ctx.stdout(`Nothing was shared for ${label}, so there is nothing to report.\n`), 0);

  const config = readConfig(repoRoot).report;
  const model = config.model ?? DEFAULT_REPORT_MODEL;
  const key = createHash('sha256').update(JSON.stringify([periodKey(period.filter), input.hash, DIGEST_PROMPT_VERSION, model])).digest('hex');
  const cacheFile = join(repoRoot, '.digest', 'cache', 'reports', `${key}.md`);
  const emit = (markdown: string) => {
    if (!out) return ctx.stdout(markdown);
    writeFileSync(out, markdown);
    ctx.stdout(`Wrote ${relative(repoRoot, out)}\n`);
  };
  if (existsSync(cacheFile)) {
    ctx.stderr(`Report for ${input.period.label}: cached, nothing sent.\n`);
    emit(readFileSync(cacheFile, 'utf8'));
    return 0;
  }

  const estimate = estimateDigestCost(input, model);
  const cost = estimate.costUsd === null ? 'cost unknown' : `$${estimate.costUsd.toFixed(4)}`;
  ctx.stderr(
    `Report for ${input.period.label} from ${count(input.coverage.summaryCount, 'summary', 'summaries')}: ${count(estimate.requests, 'request', 'requests')} to ${model}, about ${tokens(estimate.inputTokens)} input and ${tokens(estimate.outputTokens)} output tokens, estimated ${cost}\n`,
  );
  if (!options.yes) {
    if (!ctx.confirm) return fail(`this would send the report's summaries to ${model} (estimated ${cost}). Re-run with --yes to confirm, or run it in a terminal to be asked.`);
    if (!(await ctx.confirm(`Send it to ${model} for about ${cost}? [y/N] `))) return fail('Cancelled; nothing was sent.');
  }

  const llm: LlmClient = ctx.llm ?? AnthropicLlmClient.fromEnv(ctx.env, model, config.effort ?? 'medium');
  const digest = await generateDigest(input, llm, config.jargon ? { jargon: config.jargon } : {});
  writeFileSync(join(ensureDigestDir(repoRoot, 'cache', 'reports'), `${key}.md`), digest.markdown);
  emit(digest.markdown);
  return 0;
}

export async function previewCommand(options: { repo?: string }, ctx: CliContext): Promise<number> {
  const c = connect('preview', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const result = await c.target.previews(c.repoId);
  if (result.status !== 'ok') return c.fail(`the store refused the token: ${result.reason}`);
  if (!result.digests.length) return (ctx.stdout('No digests are waiting in developer preview.\n'), 0);
  for (const d of result.digests) {
    const until = d.previewUntil ? `${formatTime(d.previewUntil, ctx.timeZone)}${ctx.timeZone ? ` ${ctx.timeZone}` : ''}` : 'the next send-due run';
    // Older servers send digests without warnings (D71).
    const warning = d.warnings?.length ? warningText(d) : null;
    const note = warning ? `Warning: ${warning}\n` : d.jargonRetried ? 'A jargon retry ran; the second reply had none of the listed terms.\n' : '';
    ctx.stdout(`${d.periodLabel}: in preview until ${until}, then sent.\n${note}\n${d.markdown}\n`);
  }
  return 0;
}
