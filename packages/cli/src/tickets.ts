import { findSummary, repoIdentity, shortSessionId, type PushTarget, type SprintGroup, type TicketLink, type TicketReportFilter } from '@digest/core';
import type { CliContext } from './cli.js';
import { resolvePushTarget } from './share.js';
import { resolveRepoRoot } from './sessions.js';

// sprintdigest link / unlink (manual ticket links on a pushed summary, DECISIONS.md D45) and sprintdigest tickets (the
// grouped view from the digest server, D46). All three only talk to the shared store.

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Connection = { repoRoot: string; target: PushTarget; repoId: string; fail: (message: string) => number };

export function connect(command: string, repo: string | undefined, ctx: CliContext): Connection | { exit: number } {
  const fail = (message: string) => (ctx.stderr(`sprintdigest ${command}: ${message}\n`), 1);
  const root = resolveRepoRoot(repo, ctx);
  if ('error' in root) return { exit: fail(root.error) };
  const resolved = resolvePushTarget(ctx, root.root);
  if ('error' in resolved) return { exit: fail(resolved.error) };
  const identity = repoIdentity(root.root);
  if ('error' in identity) return { exit: fail(identity.error) };
  return { repoRoot: root.root, target: resolved.target, repoId: identity.repoId, fail };
}

export async function linkCommand(action: 'link' | 'unlink', sessionId: string, ticket: string, options: { repo?: string }, ctx: CliContext): Promise<number> {
  const c = connect(action, options.repo, ctx);
  if ('exit' in c) return c.exit;
  const { repoRoot, target, repoId, fail } = c;
  const found = findSummary(repoRoot, sessionId);
  if ('error' in found) return fail(found.error);
  const s = found.summary;
  const short = shortSessionId(s.sessionId);
  if (!s.pushedAt) return fail(`${short} has not been pushed; add ticket keys while reviewing it (sprintdigest review) instead.`);

  const ref = { agent: s.agent, sessionId: s.sessionId };
  const result = action === 'link' ? await target.link(repoId, ref, ticket) : await target.unlink(repoId, ref, ticket);
  switch (result.status) {
    case 'created':
      return (ctx.stdout(`Linked ${short} to ${ticket}.\n`), 0);
    case 'unchanged':
      return (ctx.stdout(`${short} is already linked to ${ticket}.\n`), 0);
    case 'removed':
      return (ctx.stdout(`Removed the link from ${short} to ${ticket}.\n`), 0);
    case 'unauthorized':
      return fail(`the store refused the token: ${result.reason}`);
    default:
      return fail(result.reason);
  }
}

const day = (iso: string) => (iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso);
const source = (link: TicketLink) => (link.source === 'manual' && link.addedBy ? `manual, added by ${link.addedBy}` : link.source);

function formatGroup(g: SprintGroup): string[] {
  const line = (s: { summary: { startedAt: string; goal: string }; developerName: string }, suffix = '') => `    ${s.summary.startedAt.slice(0, 10)}  ${s.developerName}  ${s.summary.goal}${suffix}`;
  const head = g.sprint === null ? 'No sprint' : g.sprint.from && g.sprint.to ? `${g.sprint.name} (${day(g.sprint.from)} up to ${day(g.sprint.to)})` : g.sprint.name;
  return [
    head,
    ...g.tickets.flatMap((t) => [`  ${t.key}${t.title ? `  ${t.title}` : ''}`, ...t.summaries.map((e) => line(e.summary, `  (${source(e.link)})`))]),
    ...(g.unlinked.length ? ['  Unlinked', ...g.unlinked.map((s) => line(s))] : []),
  ];
}

const isoDay = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value).toISOString() : null);

/** --from and --to (dates or date-times; --to is not included), or --sprint. */
export function periodOption(options: { from?: string; to?: string; sprint?: string }): { filter: TicketReportFilter } | { error: string } {
  if (options.sprint !== undefined && options.from === undefined && options.to === undefined) return { filter: { sprint: options.sprint } };
  if (options.sprint === undefined && options.from !== undefined && options.to !== undefined) {
    const [from, to] = [isoDay(options.from), isoDay(options.to)];
    if (!from || !to) return { error: '--from and --to must be dates such as 2026-03-01, or ISO date-times; --to is not included.' };
    return { filter: { from, to } };
  }
  return { error: 'pass --from and --to, or --sprint.' };
}

export async function ticketsCommand(options: { repo?: string; from?: string; to?: string; sprint?: string }, ctx: CliContext): Promise<number> {
  const c = connect('tickets', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const { target, repoId, fail } = c;
  const period = periodOption(options);
  if ('error' in period) return fail(period.error);
  const { filter } = period;

  const result = await target.tickets(repoId, filter);
  if (result.status !== 'ok') return fail(`the store refused the token: ${result.reason}`);
  const { report } = result;
  if (report.sprints.length === 0) return (ctx.stdout('Nothing pushed for that selection.\n'), 0);
  ctx.stdout(`${[...report.sprints.flatMap(formatGroup), '', `${count(report.summaryCount, 'summary', 'summaries')} from ${count(report.developerCount, 'developer', 'developers')}.`].join('\n')}\n`);
  return 0;
}

/** sprintdigest ticket title <KEY> "<title>": a title for repos without a tracker (DECISIONS.md D67). */
export async function ticketTitleCommand(ticket: string, title: string, options: { repo?: string }, ctx: CliContext): Promise<number> {
  const c = connect('ticket title', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const result = await c.target.setTicketTitle(c.repoId, ticket, title);
  if (result.status === 'saved') return (ctx.stdout(`${ticket} is titled "${title.trim()}".\n`), 0);
  return c.fail(result.status === 'rejected' ? result.reason : `the store refused the token: ${result.reason}`);
}
