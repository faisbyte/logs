import { resolve } from 'node:path';
import { agentDirs, discoverSessionFiles, findRepoRoot, isInRepo, loadSessions, validRepoRoot, type AgentDirs, type ParsedSession } from '@digest/core';
import type { CliContext } from './cli.js';

export const NOT_IN_REPO = 'not inside a git repository. Run it from your repo, or pass --repo <path>.';
const HOME = "is your home directory's git repo, which is never treated as a project. Pass --repo <path>.";

/**
 * The repo a read-only command looks at: --repo (its git root when it has one, else the path as given),
 * or the git root of the cwd. Never the home directory.
 */
export function resolveRepoRoot(repoOption: string | undefined, ctx: Pick<CliContext, 'cwd' | 'homeDir'>): { root: string } | { error: string } {
  const root = repoOption ? (findRepoRoot(resolve(ctx.cwd, repoOption)) ?? resolve(ctx.cwd, repoOption)) : findRepoRoot(ctx.cwd);
  if (!root) return { error: NOT_IN_REPO };
  if (resolve(root) === resolve(ctx.homeDir)) return { error: `${root} ${HOME}` };
  return { root };
}

/** The repo a command may write to: must exist, be inside git, and not be the home directory (DECISIONS.md D30). */
export function writableRepoRoot(repoOption: string | undefined, ctx: Pick<CliContext, 'cwd' | 'homeDir'>): { root: string } | { error: string } {
  const found = validRepoRoot(resolve(ctx.cwd, repoOption ?? '.'), ctx.homeDir);
  return 'root' in found ? found : { error: `skipped: ${found.error}; drafts need a valid repo.` };
}

export function repoSessions(repoRoot: string, ctx: CliContext): { dirs: AgentDirs; sessions: ParsedSession[] } {
  const dirs = agentDirs(ctx.env, ctx.homeDir);
  return { dirs, sessions: loadSessions(discoverSessionFiles(dirs)).filter((s) => isInRepo(s, repoRoot)) };
}

/** The one session whose id starts with `prefix`, or a message saying why there isn't exactly one. */
export function findSession(sessions: ParsedSession[], prefix: string, repoRoot: string): { session: ParsedSession } | { error: string } {
  const matches = sessions.filter((s) => s.sourceSessionId.startsWith(prefix));
  if (matches.length === 1) return { session: matches[0]! };
  if (matches.length === 0) return { error: `No session matching "${prefix}" for ${repoRoot}. Run digest list to see session ids.` };
  return { error: `"${prefix}" matches ${matches.length} sessions: ${matches.map((s) => s.sourceSessionId).join(', ')}` };
}

/** Shortest prefix (at least 8 chars) that tells every session apart, like git short SHAs. */
export function shortIdLength(ids: string[]): number {
  const unique = new Set(ids).size;
  let n = 8;
  while (new Set(ids.map((id) => id.slice(0, n))).size < unique) n++;
  return n;
}
