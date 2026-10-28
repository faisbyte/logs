#!/usr/bin/env node
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

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  // Only ask when someone can answer; otherwise multi-session runs need --yes.
  ...(process.stdin.isTTY ? { confirm } : {}),
});
