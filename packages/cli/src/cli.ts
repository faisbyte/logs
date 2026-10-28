import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const program = new Command()
    .name('digest')
    .description('Turn AI coding sessions into team digests')
    .version(version)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
}
