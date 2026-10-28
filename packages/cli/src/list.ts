import { relative } from 'node:path';
import {
  commitsDuring,
  fingerprintFile,
  isInRepo,
  readState,
  sessionKey,
  sessionStatus,
  type ParsedSession,
  type SessionStatus,
} from '@digest/core';
import type { CliContext } from './cli.js';
import { NOT_IN_REPO, repoSessions, resolveRepoRoot } from './sessions.js';

type ListedSession = ParsedSession & { status: SessionStatus };

function formatStarted(iso: string, timeZone: string | undefined): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatDuration(startedAt: string, endedAt: string): string {
  const minutes = Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function titleOf(session: ParsedSession): string {
  const firstPrompt = session.transcript.find((e) => e.kind === 'user');
  const text = (session.title ?? (firstPrompt && 'text' in firstPrompt ? firstPrompt.text : '-')).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Shortest prefix (at least 8 chars) that tells every listed session apart, like git short SHAs. */
function shortIdLength(ids: string[]): number {
  const unique = new Set(ids).size;
  let n = 8;
  while (new Set(ids.map((id) => id.slice(0, n))).size < unique) n++;
  return n;
}

function table(sessions: ListedSession[], timeZone: string | undefined): string {
  const idLength = shortIdLength(sessions.map((s) => s.sourceSessionId));
  const header = ['STARTED', 'AGENT', 'SESSION', 'DURATION', 'TURNS', 'TOOLS', 'FILES', 'COMMITS', 'STATUS', 'BRANCH', 'TITLE'];
  const rows = sessions.map((s) => [
    formatStarted(s.startedAt, timeZone),
    s.agent,
    s.sourceSessionId.slice(0, idLength),
    formatDuration(s.startedAt, s.endedAt),
    String(s.turnCount),
    String(s.toolCallCount),
    String(s.filesTouched.length),
    String(s.commitShas.length),
    s.status,
    s.gitBranch ?? '-',
    titleOf(s),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')).join('\n');
}

const repoRelative = (repoRoot: string, path: string) => (isInRepo({ cwd: path }, repoRoot) ? relative(repoRoot, path) : path);

export function listCommand(options: { repo?: string; json?: boolean }, ctx: CliContext): number {
  const repoRoot = resolveRepoRoot(options.repo, ctx.cwd);
  if (!repoRoot) {
    ctx.stderr(`digest list: ${NOT_IN_REPO}\n`);
    return 1;
  }

  const state = readState(repoRoot);
  const { dirs, sessions: inRepo } = repoSessions(repoRoot, ctx);
  const sessions: ListedSession[] = inRepo
    .map((s) => ({
      ...s,
      commitShas: commitsDuring(repoRoot, s),
      status: sessionStatus(state, sessionKey(s), fingerprintFile(s.sourcePath)),
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  if (options.json) {
    const listed = sessions.map(({ transcript: _transcript, ...s }) => ({
      ...s,
      filesTouched: s.filesTouched.map((p) => repoRelative(repoRoot, p)),
    }));
    ctx.stdout(JSON.stringify(listed, null, 2) + '\n');
    return 0;
  }

  if (sessions.length === 0) {
    ctx.stdout(`No Claude Code or Codex sessions found for ${repoRoot}.\nLooked in:\n  ${dirs.claudeProjectsDir}\n  ${dirs.codexSessionsDir}\n`);
    return 0;
  }

  const claude = sessions.filter((s) => s.agent === 'claude-code').length;
  const footer = `${sessions.length} session${sessions.length === 1 ? '' : 's'} for ${repoRoot} (${claude} Claude Code, ${sessions.length - claude} Codex)`;
  ctx.stdout(`${table(sessions, ctx.timeZone)}\n\n${footer}\n`);
  return 0;
}
