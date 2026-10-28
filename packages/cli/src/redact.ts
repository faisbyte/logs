import { readConfig, redactSession, type RedactionCounts } from '@digest/core';
import type { CliContext } from './cli.js';
import { findSession, repoSessions, resolveRepoRoot } from './sessions.js';

/** Redacts one session's full transcript and prints how many values of each type were replaced. Never the values. */
export function redactCommand(sessionId: string, options: { repo?: string }, ctx: CliContext): number {
  const resolved = resolveRepoRoot(options.repo, ctx);
  if ('error' in resolved) {
    ctx.stderr(`digest redact: ${resolved.error}\n`);
    return 1;
  }
  const repoRoot = resolved.root;

  const config = readConfig(repoRoot);
  const found = findSession(repoSessions(repoRoot, ctx).sessions, sessionId, repoRoot);
  if ('error' in found) {
    ctx.stderr(`digest redact: ${found.error}\n`);
    return 1;
  }
  const { session } = found;
  const counts = Object.entries(redactSession(session, config.redaction).counts as RedactionCounts).sort(([a], [b]) => a.localeCompare(b));
  const total = counts.reduce((sum, [, n]) => sum + (n ?? 0), 0);
  const width = Math.max(0, ...counts.map(([type]) => type.length));
  const lines = counts.map(([type, n]) => `  ${type.padEnd(width)}  ${n}`);
  ctx.stdout(`${session.sourceSessionId} (${session.agent}): ${total === 0 ? 'nothing to redact' : `${total} value${total === 1 ? '' : 's'} redacted`}\n${lines.map((l) => `${l}\n`).join('')}`);
  return 0;
}
