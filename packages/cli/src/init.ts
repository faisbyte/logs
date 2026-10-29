import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CliContext } from './cli.js';
import { writableRepoRoot } from './sessions.js';

// `digest init`: an optional pre-push reminder (DECISIONS.md D41). It only prints. It never runs digest,
// never blocks or slows a push, and never summarises anything.

const MARKER = '# digest pre-push reminder';
const HOOK = `#!/bin/sh
${MARKER} (installed by \`digest init\`; delete this file to remove it).
# It only prints a message: it never blocks or slows a push, and never runs digest.
echo "digest: when you are ready, run \\\`digest sync\\\` to summarise, review and share this work." >&2
exit 0
`;

export function initCommand(options: { repo?: string }, ctx: CliContext): number {
  const fail = (message: string) => (ctx.stderr(`digest init: ${message}\n`), 1);
  const writable = writableRepoRoot(options.repo, ctx);
  if ('error' in writable) return fail(writable.error);
  // Respects core.hooksPath and worktrees.
  const hooksPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: writable.root, encoding: 'utf8' }).trim();
  const hooksDir = isAbsolute(hooksPath) ? hooksPath : join(writable.root, hooksPath);
  if (!existsSync(hooksDir)) return fail(`the hooks directory ${hooksDir} does not exist; create it first if you want the reminder.`);

  const file = join(hooksDir, 'pre-push');
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8').includes(MARKER)) return (ctx.stdout(`The pre-push reminder is already installed (${file}).\n`), 0);
    return fail(`a pre-push hook already exists at ${file}; it was left alone. To add the reminder yourself, put this line in it:\n  echo "digest: when you are ready, run \\\`digest sync\\\` to summarise, review and share this work." >&2`);
  }
  writeFileSync(file, HOOK);
  chmodSync(file, 0o755);
  ctx.stdout(`Installed a pre-push reminder at ${file}. It only prints a message; delete the file to remove it.\n`);
  return 0;
}
