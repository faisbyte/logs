import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Creates <repo>/.digest (and any subdirectory) with a self-ignoring .gitignore, so it never reaches git. */
export function ensureDigestDir(repoRoot: string, ...sub: string[]): string {
  const root = join(repoRoot, '.digest');
  mkdirSync(join(root, ...sub), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '*\n');
  return join(root, ...sub);
}
