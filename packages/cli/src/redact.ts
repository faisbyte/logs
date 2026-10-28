import { readConfig, redactSession, type RedactionCounts } from '@digest/core';
import type { CliContext } from './cli.js';
import { NOT_IN_REPO, repoSessions, resolveRepoRoot } from './sessions.js';

/** Redacts one session's full transcript and prints how many values of each type were replaced. Never the values. */
export function redactCommand(sessionId: string, options: { repo?: string }, ctx: CliContext): number {
  const repoRoot = resolveRepoRoot(options.repo, ctx.cwd);
  if (!repoRoot) {
    ctx.stderr(`digest redact: ${NOT_IN_REPO}\n`);
    return 1;
  }

  const config = readConfig(repoRoot);
  const matches = repoSessions(repoRoot, ctx).sessions.filter((s) => s.sourceSessionId.startsWith(sessionId));
  if (matches.length === 0) {
    ctx.stderr(`digest redact: No session matching "${sessionId}" for ${repoRoot}. Run digest list to see session ids.\n`);
    return 1;
  }
  if (matches.length > 1) {
    ctx.stderr(`digest redact: "${sessionId}" matches ${matches.length} sessions: ${matches.map((s) => s.sourceSessionId).join(', ')}\n`);
    return 1;
  }

  const [session] = matches;
  const counts = Object.entries(redactSession(session!, config.redaction).counts as RedactionCounts).sort(([a], [b]) => a.localeCompare(b));
  const total = counts.reduce((sum, [, n]) => sum + (n ?? 0), 0);
  const width = Math.max(0, ...counts.map(([type]) => type.length));
  const lines = counts.map(([type, n]) => `  ${type.padEnd(width)}  ${n}`);
  ctx.stdout(`${session!.sourceSessionId} (${session!.agent}): ${total === 0 ? 'nothing to redact' : `${total} value${total === 1 ? '' : 's'} redacted`}\n${lines.map((l) => `${l}\n`).join('')}`);
  return 0;
}
