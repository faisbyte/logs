import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Command, CommanderError } from 'commander';
import { listCommand } from './list.js';

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
    .action((options: { repo?: string; json?: boolean }) => {
      try {
        exitCode = listCommand(options, ctx);
      } catch (err) {
        io.stderr(`digest list: ${(err as Error).message}\n`);
        exitCode = 1;
      }
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
}
