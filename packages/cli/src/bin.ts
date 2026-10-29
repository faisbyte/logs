#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { loadDotEnv } from './dotenv.js';

// The digest checkout's own .env (gitignored), e.g. ANTHROPIC_API_KEY; never a target repo's .env.
loadDotEnv(fileURLToPath(new URL('../../../.env', import.meta.url)), process.env);

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Runs $VISUAL or $EDITOR (default vi) on the file. The command may carry arguments, e.g. "code --wait". */
async function editor(file: string): Promise<void> {
  const command = process.env.VISUAL || process.env.EDITOR || 'vi';
  // The file goes in as $1, never pasted into the shell string.
  const result = spawnSync('/bin/sh', ['-c', `${command} "$1"`, 'editor', file], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`the editor (${command}) exited with status ${result.status ?? result.signal}; nothing was changed.`);
}

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  // Only ask when someone can answer; otherwise multi-session runs need --yes.
  ...(process.stdin.isTTY ? { confirm, ask, editor } : {}),
});
