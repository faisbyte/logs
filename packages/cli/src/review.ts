import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  shortSessionId,
  approve,
  createRedactor,
  editSummary,
  ensureDigestDir,
  findSummary,
  formatSummary,
  formatTime,
  listSummaries,
  readConfig,
  reject,
  reopen,
  saveOriginal,
  saveSummary,
  statusText,
  type SessionSummary,
} from '@digest/core';
import type { CliContext } from './cli.js';
import { resolveRepoRoot, writableRepoRoot } from './sessions.js';

// Developer review (Phase 4): the core does the work; these commands only read input and print.

interface RepoOption {
  repo?: string;
}

const short = (s: SessionSummary) => shortSessionId(s.sessionId);

export function reviewListCommand(options: RepoOption, ctx: CliContext): number {
  const resolved = resolveRepoRoot(options.repo, ctx);
  if ('error' in resolved) return (ctx.stderr(`sprintdigest review: ${resolved.error}\n`), 1);
  const summaries = listSummaries(resolved.root);
  if (summaries.length === 0) return (ctx.stdout('No summaries yet. Run sprintdigest summarize first.\n'), 0);
  const rows = summaries.map((s) => [short(s), formatTime(s.startedAt, ctx.timeZone), statusText(s, ctx.timeZone), s.goal]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  ctx.stdout(rows.map((r) => r.map((c, i) => (i < 3 ? c.padEnd(widths[i]!) : c)).join('  ')).join('\n') + '\n');
  return 0;
}

/** approve, reject and reopen: one transition on one summary, saved back in place. */
export function transitionCommand(action: 'approve' | 'reject' | 'reopen', id: string, options: RepoOption, ctx: CliContext): number {
  const fail = (message: string) => (ctx.stderr(`sprintdigest ${action}: ${message}\n`), 1);
  const writable = writableRepoRoot(options.repo, ctx);
  if ('error' in writable) return fail(writable.error);
  const found = findSummary(writable.root, id);
  if ('error' in found) return fail(found.error);
  const s = found.summary;
  if (action === 'approve') {
    saveSummary(writable.root, approve(s).summary as SessionSummary);
    ctx.stdout(`Approved ${short(s)}. It will be shared when you push.\n`);
  } else if (action === 'reject') {
    saveSummary(writable.root, reject(s));
    ctx.stdout(`Rejected ${short(s)}. It will never be uploaded or re-summarised automatically.\n`);
  } else {
    saveSummary(writable.root, reopen(s));
    ctx.stdout(`${short(s)} is a draft again.\n`);
  }
  return 0;
}

const PROMPT = '[a]pprove  [e]dit  [r]eject  [s]kip  [q]uit: ';

export async function reviewCommand(options: RepoOption, ctx: CliContext): Promise<number> {
  return (await reviewDrafts(options, ctx)).code;
}

/** The interactive review; `quit` is true when the developer stopped before the end (sprintdigest sync then stops too). */
export async function reviewDrafts(options: RepoOption, ctx: CliContext): Promise<{ code: number; quit: boolean }> {
  const fail = (message: string) => (ctx.stderr(`sprintdigest review: ${message}\n`), { code: 1, quit: false });
  const writable = writableRepoRoot(options.repo, ctx);
  if ('error' in writable) return fail(writable.error);
  const repoRoot = writable.root;
  if (!ctx.ask) return fail('reviewing one by one needs a terminal. Use sprintdigest review --list, sprintdigest approve <id> or sprintdigest reject <id>.');
  const { ask, editor } = ctx;

  const drafts = listSummaries(repoRoot).filter((s) => s.status === 'draft');
  if (drafts.length === 0) return (ctx.stdout('No drafts to review.\n'), { code: 0, quit: false });
  const redact = createRedactor(readConfig(repoRoot).redaction);
  const tally = { approved: 0, rejected: 0, skipped: 0, seen: 0 };
  let quit = false;

  // Writes the YAML under .digest/edit/, runs the editor on it and reads back what was saved.
  const open = async (run: (file: string) => Promise<void>, summary: SessionSummary, text: string) => {
    const file = join(ensureDigestDir(repoRoot, 'edit'), `${summary.agent}-${summary.sessionId}.yaml`);
    writeFileSync(file, text);
    try {
      await run(file);
      return readFileSync(file, 'utf8');
    } finally {
      rmSync(file, { force: true });
    }
  };

  review: for (let summary of drafts) {
    tally.seen++;
    ctx.stdout(`\n${formatSummary(summary, { timeZone: ctx.timeZone })}\n\n`);
    for (;;) {
      const answer = (await ask(PROMPT)).trim().toLowerCase();
      if (answer === 'a') {
        saveSummary(repoRoot, approve(summary).summary as SessionSummary);
        ctx.stdout(`Approved ${short(summary)}.\n`);
        tally.approved++;
        continue review;
      }
      if (answer === 'r') {
        saveSummary(repoRoot, reject(summary));
        ctx.stdout(`Rejected ${short(summary)}.\n`);
        tally.rejected++;
        continue review;
      }
      if (answer === 's') {
        tally.skipped++;
        continue review;
      }
      if (answer === 'q') {
        // The draft on screen, and any after it, are left for next time.
        tally.seen--;
        quit = true;
        break review;
      }
      if (answer !== 'e') continue;
      if (!editor) {
        ctx.stdout('Editing needs a terminal editor; set $EDITOR.\n');
        continue;
      }
      const current = summary;
      const result = await editSummary(current, (text) => open(editor, current, text), redact);
      if ('cancelled' in result || !result.changed) {
        ctx.stdout('No changes.\n');
        continue;
      }
      if (!current.editedByDeveloper) saveOriginal(repoRoot, current);
      saveSummary(repoRoot, result.summary);
      summary = result.summary;
      const redacted = Object.entries(result.redactions).map(([type, n]) => `${n} ${type}`);
      ctx.stdout(`Saved your edit.${redacted.length ? ` Redacted from it: ${redacted.join(', ')}.` : ''}\n\n${formatSummary(summary, { timeZone: ctx.timeZone })}\n\n`);
    }
  }

  const noun = tally.seen === 1 ? 'draft' : 'drafts';
  ctx.stdout(`\nReviewed ${tally.seen} ${noun}: ${tally.approved} approved, ${tally.rejected} rejected, ${tally.skipped} skipped.\n`);
  return { code: 0, quit };
}
