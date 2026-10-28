import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Command, CommanderError } from 'commander';
import { listCommand } from './list.js';
import { redactCommand } from './redact.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** IANA zone for displayed times; defaults to the system zone. */
  timeZone?: string;
}

export type CliContext = Required<Omit<CliIo, 'timeZone'>> & Pick<CliIo, 'timeZone'>;

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const ctx: CliContext = { cwd: process.cwd(), env: process.env, homeDir: homedir(), ...io };
  let exitCode = 0;
  // Runs a command, turning an expected failure (bad state or config file) into a message and exit code 1.
  const guarded = (name: string, command: () => number) => {
    try {
      exitCode = command();
    } catch (err) {
      io.stderr(`digest ${name}: ${(err as Error).message}\n`);
      exitCode = 1;
    }
  };

  const program = new Command()
    .name('digest')
    .description('Turn AI coding sessions into team digests')
    .version(version)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command('list')
    .description('Show Claude Code and Codex sessions recorded for this repo')
    .option('--repo <path>', 'repo to list sessions for (default: the git repo containing the current directory)')
    .option('--json', 'print sessions as JSON')
    .option('--all', 'include empty sessions (a prompt with no reply or tool call)')
    .action((options: { repo?: string; json?: boolean; all?: boolean }) => guarded('list', () => listCommand(options, ctx)));

  program
    .command('redact')
    .argument('<sessionId>', 'session id or a unique prefix of it (see digest list)')
    .description('Redact a session and print how many values of each type were replaced (never the values)')
    .option('--repo <path>', 'repo the session belongs to (default: the git repo containing the current directory)')
    .action((sessionId: string, options: { repo?: string }) => guarded('redact', () => redactCommand(sessionId, options, ctx)));

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
}
