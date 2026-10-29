import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { LlmClient } from '@digest/core';
import { Command, CommanderError } from 'commander';
import { listCommand } from './list.js';
import { redactCommand } from './redact.js';
import { reviewCommand, reviewListCommand, transitionCommand } from './review.js';
import { summarizeCommand } from './summarize.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** IANA zone for displayed times; defaults to the system zone. */
  timeZone?: string;
  /** Model client for summarize; defaults to the Anthropic API with ANTHROPIC_API_KEY. */
  llm?: LlmClient;
  /** Asks a yes/no question; absent when there is no terminal to ask in. */
  confirm?: (question: string) => Promise<boolean>;
  /** Asks a question and returns the typed answer; absent when there is no terminal. */
  ask?: (question: string) => Promise<string>;
  /** Opens a file in the developer's editor and resolves when it is closed; absent when there is no terminal. */
  editor?: (file: string) => Promise<void>;
}

type Optional = 'timeZone' | 'llm' | 'confirm' | 'ask' | 'editor';
export type CliContext = Required<Omit<CliIo, Optional>> & Pick<CliIo, Optional>;

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const ctx: CliContext = { cwd: process.cwd(), env: process.env, homeDir: homedir(), ...io };
  let exitCode = 0;
  // Runs a command, turning an expected failure (bad state or config file) into a message and exit code 1.
  const guarded = async (name: string, command: () => number | Promise<number>) => {
    try {
      exitCode = await command();
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

  program
    .command('summarize')
    .argument('[sessionId]', 'session id or a unique prefix of it (see digest list)')
    .description('Summarise sessions into local drafts; sends redacted, condensed session text to the Anthropic API with your key')
    .option('--all', 'summarise every non-empty session for the repo')
    .option('--estimate', 'print how many sessions would be sent and the estimated cost, then stop')
    .option('--yes', 'skip the confirmation before sending more than one session')
    .option('--repo <path>', 'repo the sessions belong to (default: the git repo containing the current directory)')
    .action((sessionId: string | undefined, options: { all?: boolean; estimate?: boolean; yes?: boolean; repo?: string }) =>
      guarded('summarize', () => summarizeCommand(sessionId, options, ctx)),
    );

  const repoOption = ['--repo <path>', 'repo the summaries belong to (default: the git repo containing the current directory)'] as const;

  program
    .command('review')
    .description('Step through draft summaries: approve, edit in $EDITOR, reject or skip each one')
    .option('--list', 'list every summary with its status instead')
    .option(...repoOption)
    .action((options: { list?: boolean; repo?: string }) =>
      guarded('review', () => (options.list ? reviewListCommand(options, ctx) : reviewCommand(options, ctx))),
    );

  for (const [action, description] of [
    ['approve', 'Approve a draft summary so it can be pushed'],
    ['reject', 'Reject a draft summary: it is never uploaded or re-summarised automatically'],
    ['reopen', 'Put an approved or rejected summary back to draft (only before it is pushed)'],
  ] as const) {
    program
      .command(action)
      .argument('<sessionId>', 'session id or a unique prefix of it (see digest review --list)')
      .description(description)
      .option(...repoOption)
      .action((sessionId: string, options: { repo?: string }) => guarded(action, () => transitionCommand(action, sessionId, options, ctx)));
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
}
