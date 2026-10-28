import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { findRepoRoot } from './git.js';

/** A session belongs to a repo when its launch cwd is the repo root or inside it (DECISIONS.md D7). */
export function isInRepo(session: { cwd: string }, repoRoot: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(session.cwd));
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return !outside;
}

/**
 * The repo a write may go to (DECISIONS.md D30): an existing path inside a git repo whose root is not
 * the home directory. Anything else is an error, never a directory to create.
 */
export function validRepoRoot(path: string, homeDir: string): { root: string } | { error: string } {
  if (!existsSync(path)) return { error: `${path} does not exist` };
  const root = findRepoRoot(path);
  if (!root) return { error: `${path} is not inside a git repository` };
  if (resolve(root) === resolve(homeDir)) return { error: `${path} is only inside your home directory's git repo, which is never treated as a project` };
  return { root };
}
