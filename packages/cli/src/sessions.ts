import { resolve } from 'node:path';
import { agentDirs, discoverSessionFiles, findRepoRoot, isInRepo, loadSessions, type AgentDirs, type ParsedSession } from '@digest/core';
import type { CliContext } from './cli.js';

/** The repo a command acts on: --repo (resolved to its git root when it has one), else the git root of the cwd. */
export function resolveRepoRoot(repoOption: string | undefined, cwd: string): string | null {
  if (!repoOption) return findRepoRoot(cwd);
  const path = resolve(cwd, repoOption);
  return findRepoRoot(path) ?? path;
}

export const NOT_IN_REPO = 'not inside a git repository. Run it from your repo, or pass --repo <path>.';

export function repoSessions(repoRoot: string, ctx: CliContext): { dirs: AgentDirs; sessions: ParsedSession[] } {
  const dirs = agentDirs(ctx.env, ctx.homeDir);
  return { dirs, sessions: loadSessions(discoverSessionFiles(dirs)).filter((s) => isInRepo(s, repoRoot)) };
}
