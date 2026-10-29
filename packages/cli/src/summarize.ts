import {
  AnthropicLlmClient,
  approve,
  isReviewed,
  readSummaryFile,
  saveSummary,
  summaryPath,
  cacheKey,
  contentHash,
  estimateSummaryCost,
  fingerprintFile,
  isEmptySession,
  markProcessed,
  prepareSessionForRepo,
  PROMPT_VERSION,
  readCachedSummary,
  readConfig,
  readState,
  redactSession,
  sessionKey,
  summarizeCached,
  summarizeSettings,
  writeState,
  type LlmClient,
  type ParsedSession,
  type SessionSummary,
} from '@digest/core';
import type { CliContext } from './cli.js';
import { findSession, repoSessions, shortIdLength, writableRepoRoot } from './sessions.js';

interface SummarizeOptions {
  repo?: string;
  all?: boolean;
  yes?: boolean;
  estimate?: boolean;
}

const tokens = (n: number) => n.toLocaleString('en-US');
const dollars = (n: number | null) => (n === null ? 'cost unknown' : `$${n.toFixed(4)}`);

/** Summarises sessions into local drafts. Only redacted, condensed text is sent, with the developer's own key. */
export async function summarizeCommand(sessionId: string | undefined, options: SummarizeOptions, ctx: CliContext): Promise<number> {
  const fail = (message: string) => (ctx.stderr(`digest summarize: ${message}\n`), 1);
  const writable = writableRepoRoot(options.repo, ctx);
  if ('error' in writable) return fail(writable.error);
  const repoRoot = writable.root;
  if (!sessionId === !options.all) return fail('pass a session id or --all (see digest list).');

  const config = readConfig(repoRoot);
  const settings = summarizeSettings(config);
  const { sessions } = repoSessions(repoRoot, ctx);

  let selected: ParsedSession[];
  if (sessionId) {
    const found = findSession(sessions, sessionId, repoRoot);
    if ('error' in found) return fail(found.error);
    if (isEmptySession(found.session)) return fail(`session ${found.session.sourceSessionId} is empty (a prompt with no reply); nothing to summarise.`);
    selected = [found.session];
  } else {
    selected = sessions.filter((s) => !isEmptySession(s)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  const idLength = shortIdLength(selected.map((s) => s.sourceSessionId));
  const shortId = (s: ParsedSession) => s.sourceSessionId.slice(0, idLength);
  const current = (s: ParsedSession) => readSummaryFile(summaryPath(repoRoot, { agent: s.agent, sessionId: s.sourceSessionId }));
  // Reviewed summaries are never regenerated; rejected ones only when asked for by id (DECISIONS.md D37).
  const held = selected.flatMap((session) => {
    const existing = current(session);
    if (existing && isReviewed(existing)) return [{ session, note: `kept: ${existing.status === 'approved' ? 'approved' : 'edited'} summaries are never re-summarised` }];
    if (existing?.status === 'rejected' && options.all) return [{ session, note: 'skipped: rejected' }];
    return [];
  });
  selected = selected.filter((s) => !held.some((h) => h.session === s));

  const plan = selected.map((session) => {
    // Repo-relative files and commits come from the parsed session and git, before redaction (DECISIONS.md D29).
    const redacted = redactSession(prepareSessionForRepo(session, repoRoot), config.redaction);
    const key = cacheKey({ sessionId: session.sourceSessionId, contentHash: contentHash(redacted, settings.chunkTokens), promptVersion: PROMPT_VERSION, model: settings.model });
    const cached = readCachedSummary(repoRoot, key) !== null;
    return { session, redacted, cached, estimate: cached ? null : estimateSummaryCost(redacted, settings), id: shortId(session) };
  });
  const toSend = plan.filter((p) => !p.cached);
  const total = (field: 'inputTokens' | 'outputTokens') => toSend.reduce((n, p) => n + p.estimate![field], 0);
  const cost = toSend.some((p) => p.estimate!.costUsd === null) ? null : toSend.reduce((n, p) => n + p.estimate!.costUsd!, 0);

  if (options.estimate) {
    const noun = toSend.length === 1 ? 'session' : 'sessions';
    ctx.stdout(
      `${toSend.length} ${noun} to summarise with ${settings.model} (${plan.length - toSend.length} cached): about ${tokens(total('inputTokens'))} input and ${tokens(total('outputTokens'))} output tokens, estimated ${dollars(cost)}\n`,
    );
    for (const p of toSend) ctx.stdout(`  ${p.id}  ${p.estimate!.requests} request${p.estimate!.requests === 1 ? '' : 's'}, about ${tokens(p.estimate!.inputTokens)} input tokens, ${dollars(p.estimate!.costUsd)}\n`);
    return 0;
  }

  if (toSend.length > 1 && !options.yes) {
    const question = `Send ${toSend.length} sessions to ${settings.model} for about ${dollars(cost)}? [y/N] `;
    if (!ctx.confirm) return fail(`this would send ${toSend.length} sessions (estimated ${dollars(cost)}). Re-run with --yes to confirm, or run it in a terminal to be asked.`);
    if (!(await ctx.confirm(question))) return fail('Cancelled; nothing was sent.');
  }

  const llm: LlmClient | null = toSend.length ? (ctx.llm ?? AnthropicLlmClient.fromEnv(ctx.env, settings.model, settings.effort)) : null;
  let state = readState(repoRoot);
  for (const h of held) ctx.stdout(`${shortId(h.session)}  ${h.note}\n`);
  // With review.autoApprove on, a fresh draft is approved at once, marked as automatic (DECISIONS.md D37).
  const autoApprove = (session: ParsedSession) => {
    const draft = config.review.autoApprove ? current(session) : null;
    if (draft?.status !== 'draft') return '';
    saveSummary(repoRoot, approve(draft, { by: 'auto' }).summary as SessionSummary);
    return '  approved automatically';
  };
  const done = { inputTokens: 0, outputTokens: 0, cost: 0 as number | null, summarised: 0, failed: 0 };

  for (const p of plan) {
    const markDone = () => (state = markProcessed(state, sessionKey(p.session), fingerprintFile(p.session.sourcePath), new Date()));
    if (p.cached) {
      ctx.stdout(`${p.id}  cached${autoApprove(p.session)}\n`);
      markDone();
      continue;
    }
    try {
      const { summary } = await summarizeCached(repoRoot, p.redacted, llm!, settings);
      const { inputTokens, outputTokens, costUsd } = summary.usage;
      ctx.stdout(`${p.id}  summarised  ${tokens(inputTokens)} in / ${tokens(outputTokens)} out tokens  ${dollars(costUsd)}${autoApprove(p.session)}\n`);
      done.inputTokens += inputTokens;
      done.outputTokens += outputTokens;
      done.cost = done.cost === null || costUsd === null ? null : done.cost + costUsd;
      done.summarised++;
      markDone();
    } catch (err) {
      ctx.stdout(`${p.id}  failed: ${(err as Error).message}\n`);
      done.failed++;
    }
  }
  writeState(repoRoot, state);

  ctx.stdout(
    `\nSummarised ${done.summarised} of ${plan.length} (${plan.length - toSend.length} cached, ${done.failed} failed): ${tokens(done.inputTokens)} in / ${tokens(done.outputTokens)} out tokens, ${dollars(done.cost)}. Drafts are in .digest/summaries/.\n`,
  );
  return done.failed ? 1 : 0;
}
