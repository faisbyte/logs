import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { LlmClient, PushTarget } from '@digest/core';
import { Command, CommanderError } from 'commander';
import { initCommand } from './init.js';
import { listCommand } from './list.js';
import { pushCommand } from './push.js';
import { previewCommand, reportCommand } from './report.js';
import { retractCommand } from './retract.js';
import { linkCommand, ticketsCommand } from './tickets.js';
import { redactCommand } from './redact.js';
import { reviewCommand, reviewListCommand, transitionCommand } from './review.js';
import { summarizeCommand } from './summarize.js';
import { syncCommand } from './sync.js';

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
  /** The shared store, behind its auth; absent until one is configured. */
  pushTarget?: PushTarget;
}

type Optional = 'timeZone' | 'llm' | 'confirm' | 'ask' | 'editor' | 'pushTarget';
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
      io.stderr(`sprintdigest ${name}: ${(err as Error).message}\n`);
      exitCode = 1;
    }
  };

  const program = new Command()
    .name('sprintdigest')
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
    .argument('<sessionId>', 'session id or a unique prefix of it (see sprintdigest list)')
    .description('Redact a session and print how many values of each type were replaced (never the values)')
    .option('--repo <path>', 'repo the session belongs to (default: the git repo containing the current directory)')
    .action((sessionId: string, options: { repo?: string }) => guarded('redact', () => redactCommand(sessionId, options, ctx)));

  program
    .command('summarize')
    .argument('[sessionId]', 'session id or a unique prefix of it (see sprintdigest list)')
    .description('Summarise sessions into local drafts; sends redacted, condensed session text to the Anthropic API with your key')
    .option('--all', 'summarise every non-empty session for the repo')
    .option('--estimate', 'print how many sessions would be sent and the estimated cost, then stop')
    .option('--yes', 'skip the confirmation before sending more than one session')
    .option('--by-period', 'write one summary per work period (split at gaps of 6 hours or more) instead of one per session')
    .option('--repo <path>', 'repo the sessions belong to (default: the git repo containing the current directory)')
    .action((sessionId: string | undefined, options: { all?: boolean; estimate?: boolean; yes?: boolean; byPeriod?: boolean; repo?: string }) =>
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
      .argument('<sessionId>', 'session id or a unique prefix of it (see sprintdigest review --list)')
      .description(description)
      .option(...repoOption)
      .action((sessionId: string, options: { repo?: string }) => guarded(action, () => transitionCommand(action, sessionId, options, ctx)));
  }

  program
    .command('sync')
    .description('Summarise new sessions (showing the cost first), review the drafts, then push what you approved')
    .option(...repoOption)
    .action((options: { repo?: string }) => guarded('sync', () => syncCommand(options, ctx)));

  program
    .command('init')
    .description('Install an optional pre-push reminder to run sprintdigest sync (it only prints; it never blocks a push)')
    .option(...repoOption)
    .action((options: { repo?: string }) => guarded('init', () => initCommand(options, ctx)));

  program
    .command('push')
    .description('Push approved summaries to the shared store (only the shared fields; drafts and rejected summaries never leave)')
    .option(...repoOption)
    .action((options: { repo?: string }) => guarded('push', () => pushCommand(options, ctx)));

  for (const [action, description] of [
    ['link', 'Link a pushed summary to another ticket (only the developer who pushed it can)'],
    ['unlink', 'Remove a link added with sprintdigest link (ticket keys inside the summary stay)'],
  ] as const) {
    program
      .command(action)
      .argument('<sessionId>', 'session id or a unique prefix of it (see sprintdigest review --list)')
      .argument('<ticket>', 'ticket key, e.g. PROJ-142')
      .description(description)
      .option(...repoOption)
      .action((sessionId: string, ticket: string, options: { repo?: string }) => guarded(action, () => linkCommand(action, sessionId, ticket, options, ctx)));
  }

  program
    .command('tickets')
    .description("Show the team's pushed summaries grouped by sprint, then ticket")
    .option('--from <date>', 'start of a date range, e.g. 2026-03-01')
    .option('--to <date>', 'end of the date range (not included)')
    .option('--sprint <name>', 'one sprint by name instead of a date range')
    .option(...repoOption)
    .action((options: { from?: string; to?: string; sprint?: string; repo?: string }) => guarded('tickets', () => ticketsCommand(options, ctx)));

  program
    .command('retract')
    .argument('<sessionId>', 'session id or a unique prefix of it (see sprintdigest review --list)')
    .description('Withdraw a summary you pushed from the shared store; it becomes a draft again here')
    .option(...repoOption)
    .action((sessionId: string, options: { repo?: string }) => guarded('retract', () => retractCommand(sessionId, options, ctx)));

  program
    .command('report')
    .description("Write a plain-language report of the team's shared AI work for a sprint or date range, with your own API key (cost estimate first)")
    .option('--from <date>', 'start of a date range, e.g. 2026-03-01')
    .option('--to <date>', 'end of the date range (not included)')
    .option('--sprint <name>', 'one sprint by name instead of a date range')
    .option('--yes', 'skip the confirmation before sending')
    .option('--out <file>', 'write the Markdown to a file in the repo instead of printing it')
    .option(...repoOption)
    .action((options: { from?: string; to?: string; sprint?: string; yes?: boolean; out?: string; repo?: string }) => guarded('report', () => reportCommand(options, ctx)));

  program
    .command('preview')
    .description('Show scheduled digests waiting in developer preview before they are sent')
    .option(...repoOption)
    .action((options: { repo?: string }) => guarded('preview', () => previewCommand(options, ctx)));

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
}
