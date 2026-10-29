import { execFileSync } from 'node:child_process';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function findRepoRoot(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--show-toplevel']) || null;
}

const toSeconds = (iso: string) => Date.parse(iso) / 1000;
const gitDate = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Commits on any branch the session recorded whose commit time falls inside the session (DECISIONS.md D6).
 * Branches that no longer exist are skipped. Oldest first.
 */
export function commitsDuring(
  repoRoot: string,
  session: { startedAt: string; endedAt: string; gitBranches: string[] },
): string[] {
  const refs = session.gitBranches
    .map((b) => `refs/heads/${b}`)
    .filter((ref) => git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]) !== null);
  if (refs.length === 0) return [];

  // Git dates have one-second resolution, so widen the window to whole seconds.
  const from = Math.floor(toSeconds(session.startedAt));
  const to = Math.ceil(toSeconds(session.endedAt));
  const out = git(repoRoot, ['log', '--format=%H %ct', `--since=${gitDate(from)}`, `--until=${gitDate(to)}`, ...refs, '--']);
  if (!out) return [];

  return out
    .split('\n')
    .map((line) => {
      const [sha, ct] = line.split(' ');
      return { sha: sha!, time: Number(ct) };
    })
    .filter((c) => c.time >= from && c.time <= to)
    .sort((a, b) => a.time - b.time)
    .map((c) => c.sha);
}

/** Repo-relative paths changed by the given commits, sorted and de-duplicated. */
export function filesInCommits(repoRoot: string, shas: readonly string[]): string[] {
  const files = shas.flatMap((sha) => (git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]) ?? '').split('\n').filter(Boolean));
  return [...new Set(files)].sort();
}

/** Full commit messages, for local ticket-key extraction only; they are never stored or sent (DECISIONS.md D44). */
export function commitMessages(repoRoot: string, shas: readonly string[]): string[] {
  return shas.map((sha) => git(repoRoot, ['show', '-s', '--format=%B', sha])).filter((m): m is string => m !== null);
}
