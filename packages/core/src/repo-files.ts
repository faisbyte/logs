import { resolve } from 'node:path';
import { commitsDuring, filesInCommits } from './git.js';
import type { ParsedSession } from './schema.js';

// filesTouched as the team should see them: repo-relative paths inside the repo only (DECISIONS.md D29).

const WORKTREE = /^\.claude\/worktrees\/[^/]+\/(.+)$/;
const NOT_PROJECT_FILES = /^(\.git|\.digest)\//;

/** A path as seen from the repo root, or null when it is outside the repo (temp, scratchpad, ~/.claude, other repos). */
function toRepoPath(path: string, cwd: string, repoRoot: string): string | null {
  const root = resolve(repoRoot);
  const absolute = path.startsWith('~') ? path : resolve(cwd, path);
  if (!absolute.startsWith(`${root}/`)) return null;
  const rel = absolute.slice(root.length + 1);
  const inRepo = WORKTREE.exec(rel)?.[1] ?? rel; // a Claude Code worktree is a copy of the repo
  return NOT_PROJECT_FILES.test(inRepo) ? null : inRepo;
}

export function repoFiles(session: Pick<ParsedSession, 'filesTouched' | 'cwd'>, repoRoot: string): string[] {
  const paths = session.filesTouched.map((p) => toRepoPath(p, session.cwd, repoRoot)).filter((p): p is string => p !== null);
  return [...new Set(paths)].sort();
}

/**
 * The session as it relates to `repoRoot`: commits made during it, and repo-relative files touched. Those are the
 * files the transcript shows edited plus the files its commits changed: edits made through shell commands only
 * show up in the commits (DECISIONS.md D62).
 */
export function prepareSessionForRepo(session: ParsedSession, repoRoot: string): ParsedSession {
  const commitShas = commitsDuring(repoRoot, session);
  const files = [...new Set([...repoFiles(session, repoRoot), ...filesInCommits(repoRoot, commitShas)])].sort();
  return {
    ...session,
    commitShas,
    filesTouched: files,
    subagents: session.subagents.map((a) => ({ ...a, filesTouched: repoFiles({ filesTouched: a.filesTouched, cwd: session.cwd }, repoRoot) })),
  };
}
