import { isAbsolute, relative, resolve, sep } from 'node:path';

/** A session belongs to a repo when its launch cwd is the repo root or inside it (DECISIONS.md D7). */
export function isInRepo(session: { cwd: string }, repoRoot: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(session.cwd));
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return !outside;
}
