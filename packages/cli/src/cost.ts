import { execFileSync } from 'node:child_process';
import { COST_NOTICE, findRepoRoot, repoIdentity, type CostReport, type CostSession } from '@digest/core';
import type { CliContext } from './cli.js';
import { resolvePushTarget } from './share.js';
import { connect, periodOption } from './tickets.js';

// sprintdigest cost (Phase 12, DECISIONS.md D106, D107): a developer's own AI cost, and the hook that reports a commit.

const DAY = 86_400_000;
const usd = (micros: number) => `about $${(micros / 1e6).toFixed(2)}`;
const PLACE = { shared: 'shared repo', company: 'other company repo', outside: 'outside company repos', unknown: 'repo not reported' } as const;

function lines(s: CostSession): string[] {
  const commits = s.commits.length ? s.commits.map((c) => c.sha.slice(0, 7)).join(' ') : 'no commit';
  const out = [`  ${s.date}  ${s.sessionId.slice(0, 8)}  ${s.micros === null ? 'no price' : usd(s.micros)}  ${PLACE[s.place]}  ${commits}`];
  for (const f of s.flags) {
    const [first, ...rest] = f.notes;
    const asked = first && first.by === f.flaggedBy ? `: ${first.text}` : '';
    out.push(`    ${f.flaggedByName} asked to discuss this${asked}${f.resolvedAt ? ' (resolved)' : ''}`);
    for (const n of asked ? rest : f.notes) out.push(`    ${n.name}: ${n.text}`);
  }
  return out;
}

function text(r: CostReport): string {
  return [
    `Your AI cost on ${r.repoId}, ${r.from.slice(0, 10)} up to ${r.to.slice(0, 10)}: ${usd(r.totalMicros)} (estimated)`,
    ...(r.billing.subscription ? ['Subscription amounts are API-equivalent estimates, not money spent.'] : []),
    ...(r.unpricedRequests ? [`${r.unpricedRequests} requests have no price set, so they are not in the total.`] : []),
    '',
    ...(r.sessions.length ? r.sessions.flatMap(lines) : ['  No sessions recorded.']),
    '',
    COST_NOTICE,
    '',
  ].join('\n');
}

export async function costCommand(options: { repo?: string; from?: string; to?: string; sprint?: string }, ctx: CliContext): Promise<number> {
  const c = connect('cost', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const today = Date.parse(`${ctx.now().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const none = options.from === undefined && options.to === undefined && options.sprint === undefined;
  const period = none ? { filter: { from: new Date(today - 29 * DAY).toISOString(), to: new Date(today + DAY).toISOString() } } : periodOption(options);
  if ('error' in period) return c.fail(period.error);
  const result = await c.target.cost(c.repoId, period.filter);
  if (result.status === 'off') return (ctx.stdout(`Cost tracking is off for ${c.repoId}: nothing is recorded.\n`), 0);
  if (result.status === 'invalid') return c.fail(result.reason);
  if (result.status !== 'ok') return c.fail(`the store refused the token: ${result.reason}`);
  ctx.stdout(text(result.report));
  return 0;
}

/** How recently HEAD must have been committed to be the commit the hook ran after. */
const FRESH_MS = 120_000;
/** A hook must not hold the agent up. */
const HOOK_TIMEOUT_MS = 5_000;

/**
 * A Claude Code PostToolUse hook. After a `git commit` in a repo set up to share with a digest server, it reports the
 * session id and the commit's hash: never the command, the message or any file. It prints nothing and always succeeds.
 */
export async function commitHookCommand(ctx: CliContext): Promise<number> {
  try {
    const input = JSON.parse(await ctx.stdin()) as { session_id?: unknown; cwd?: unknown; tool_name?: unknown; tool_input?: { command?: unknown } };
    const { session_id: sessionId, cwd, tool_name: tool, tool_input: { command } = {} } = input;
    if (tool !== 'Bash' || typeof sessionId !== 'string' || typeof cwd !== 'string' || typeof command !== 'string' || !/\bgit\b[^|;&]*\bcommit\b/.test(command)) return 0;
    const root = findRepoRoot(cwd);
    if (!root) return 0;
    const resolved = resolvePushTarget(ctx, root, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) }));
    const identity = repoIdentity(root);
    if ('error' in resolved || 'error' in identity) return 0;
    const [sha, seconds] = execFileSync('git', ['log', '-1', '--format=%H %ct'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ');
    if (!sha || Math.abs(ctx.now().getTime() - Number(seconds) * 1000) > FRESH_MS) return 0;
    await resolved.target.recordCommit(identity.repoId, { agent: 'claude-code', sessionId, sha });
  } catch {
    // Nothing a hook does may disturb the agent; a missed hash only means the dashboard shows no commit.
  }
  return 0;
}
