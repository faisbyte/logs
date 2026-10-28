import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Creates <repo>/.digest (and any subdirectory) with a self-ignoring .gitignore, so it never reaches git. */
export function ensureDigestDir(repoRoot: string, ...sub: string[]): string {
  // Never create the repo itself: a missing root means a deleted project, not one to recreate.
  if (!existsSync(repoRoot)) throw new Error(`Repo root ${repoRoot} does not exist; nothing was written.`);
  const root = join(repoRoot, '.digest');
  mkdirSync(join(root, ...sub), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '*\n');
  return join(root, ...sub);
}
