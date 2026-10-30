import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSummary, SHARED_HEADER } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { draftSummary } from '../../core/test/review/helpers.js';
import { runCli, type CliIo } from '../src/cli.js';

const A = 'aaaa1111-0000-4000-8000-000000000001';
const B = 'bbbb2222-0000-4000-8000-000000000002';
// Assembled at runtime so no literal token sits in the source (fake: not a real credential).
const fakeToken = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

function repoWithDrafts() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-review-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  saveSummary(repo, draftSummary({ sessionId: A, goal: 'Rate limit the login endpoint.', startedAt: '2026-03-01T09:00:00.000Z' }));
  saveSummary(repo, draftSummary({ sessionId: B, goal: 'Speed up search.', startedAt: '2026-03-02T09:00:00.000Z' }));
  return repo;
}
const stored = (repo: string, id: string) => JSON.parse(readFileSync(join(repo, '.digest/summaries', `claude-code-${id}.json`), 'utf8'));

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

/** Answers questions in order, recording them. */
const answers = (...replies: string[]) => {
  const asked: string[] = [];
  return { asked, ask: async (q: string) => (asked.push(q), replies.shift() ?? 'q') };
};

describe('sprintdigest review --list', () => {
  it('lists every summary with its status and goal', async () => {
    const repo = repoWithDrafts();
    await run(['approve', 'aaaa', '--repo', repo]);
    const { exitCode, stdout } = await run(['review', '--list', '--repo', repo]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^aaaa1111 +2026-03-01 09:00 +approved by the developer .* +Rate limit the login endpoint\.$/m);
    expect(stdout).toMatch(/^bbbb2222 +2026-03-02 09:00 +draft +Speed up search\.$/m);
  });

  it('says when there is nothing to review yet', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-review-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    expect((await run(['review', '--list', '--repo', repo])).stdout).toContain('No summaries yet. Run sprintdigest summarize first.');
  });
});

describe('sprintdigest approve / reject / reopen', () => {
  it('approves a draft by id prefix, as the developer', async () => {
    const repo = repoWithDrafts();
    const { exitCode, stdout } = await run(['approve', 'aaaa', '--repo', repo]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Approved aaaa1111. It will be shared when you push.');
    expect(stored(repo, A)).toMatchObject({ status: 'approved', approvedBy: 'developer' });
  });

  it('rejects a draft, and refuses to approve it until it is reopened', async () => {
    const repo = repoWithDrafts();
    expect((await run(['reject', 'bbbb', '--repo', repo])).stdout).toContain('Rejected bbbb2222. It will never be uploaded or re-summarised automatically.');
    const again = await run(['approve', 'bbbb', '--repo', repo]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toMatch(/rejected; reopen it/);
    expect((await run(['reopen', 'bbbb', '--repo', repo])).stdout).toContain('bbbb2222 is a draft again.');
    expect((await run(['approve', 'bbbb', '--repo', repo])).exitCode).toBe(0);
  });

  it('puts an approved summary back to draft', async () => {
    const repo = repoWithDrafts();
    await run(['approve', 'aaaa', '--repo', repo]);
    await run(['reopen', 'aaaa', '--repo', repo]);
    expect(stored(repo, A)).toMatchObject({ status: 'draft', approvedAt: null, approvedBy: null });
  });

  it('explains an unknown or ambiguous id', async () => {
    const repo = repoWithDrafts();
    saveSummary(repo, draftSummary({ sessionId: 'aaaa9999-0000-4000-8000-000000000003' }));
    expect((await run(['approve', 'zzzz', '--repo', repo])).stderr).toContain('No summary matching zzzz');
    expect((await run(['approve', 'aaaa', '--repo', repo])).stderr).toContain('matches 2 summaries');
  });
});

describe('sprintdigest review (interactive)', () => {
  it('steps through the drafts as readable text under the shared-fields header', async () => {
    const repo = repoWithDrafts();
    const { ask, asked } = answers('a', 'r');
    const { exitCode, stdout } = await run(['review', '--repo', repo], { ask });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(SHARED_HEADER);
    expect(stdout).toContain('Goal: Rate limit the login endpoint.');
    expect(asked[0]).toBe('[a]pprove  [e]dit  [r]eject  [s]kip  [q]uit: ');
    expect(stored(repo, A).status).toBe('approved');
    expect(stored(repo, B).status).toBe('rejected');
    expect(stdout).toContain('Reviewed 2 drafts: 1 approved, 1 rejected, 0 skipped.');
  });

  it('skips and quits without changing anything, and asks again after an unknown answer', async () => {
    const repo = repoWithDrafts();
    const { ask, asked } = answers('x', 's', 'q');
    const { stdout } = await run(['review', '--repo', repo], { ask });
    expect(asked).toHaveLength(3);
    expect(stored(repo, A).status).toBe('draft');
    expect(stored(repo, B).status).toBe('draft');
    expect(stdout).toContain('Reviewed 1 draft: 0 approved, 0 rejected, 1 skipped.');
  });

  it('only shows drafts', async () => {
    const repo = repoWithDrafts();
    await run(['approve', 'aaaa', '--repo', repo]);
    const { ask } = answers('s');
    const { stdout } = await run(['review', '--repo', repo], { ask });
    expect(stdout).not.toContain('Rate limit the login endpoint.');
    expect(stdout).toContain('Speed up search.');
  });

  it('edits in $EDITOR, re-redacts the text, keeps the original, then shows the result for approval', async () => {
    const repo = repoWithDrafts();
    const { ask } = answers('e', 'a');
    const editor = async (file: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('goal: Rate limit the login endpoint.', `goal: Rate limit login with ${fakeToken}`));
    const { stdout } = await run(['review', '--repo', repo], { ask, editor });
    expect(stdout).toContain('Saved your edit. Redacted from it: 1 github_token.');
    expect(stdout).toContain('Goal: Rate limit login with [REDACTED:github_token]');
    expect(stored(repo, A)).toMatchObject({ status: 'approved', editedByDeveloper: true, goal: 'Rate limit login with [REDACTED:github_token]' });
    expect(JSON.stringify(stored(repo, A))).not.toContain(fakeToken);
    expect(JSON.parse(readFileSync(join(repo, '.digest/originals', `claude-code-${A}.json`), 'utf8')).goal).toBe('Rate limit the login endpoint.');
    expect(existsSync(join(repo, '.digest/edit', `claude-code-${A}.yaml`))).toBe(false);
  });

  it('changes nothing when the editor is closed without saving', async () => {
    const repo = repoWithDrafts();
    const { ask } = answers('e', 's');
    const { stdout } = await run(['review', '--repo', repo], { ask, editor: async () => {} });
    expect(stdout).toContain('No changes.');
    expect(stored(repo, A)).toMatchObject({ status: 'draft', editedByDeveloper: false });
    expect(existsSync(join(repo, '.digest/originals'))).toBe(false);
  });

  it('reopens an invalid edit with the errors at the top', async () => {
    const repo = repoWithDrafts();
    const { ask } = answers('e', 's');
    const seen: string[] = [];
    const editor = async (file: string) => {
      const text = readFileSync(file, 'utf8');
      seen.push(text);
      writeFileSync(file, seen.length === 1 ? text.replace('outcome: completed', 'outcome: finished') : text.replace('outcome: finished', 'outcome: partial'));
    };
    await run(['review', '--repo', repo], { ask, editor });
    expect(seen[1]).toMatch(/^# ERROR: outcome:/);
    expect(stored(repo, A)).toMatchObject({ outcome: 'partial', editedByDeveloper: true });
  });

  it('needs a terminal, and points at the non-interactive commands', async () => {
    const repo = repoWithDrafts();
    const { exitCode, stderr } = await run(['review', '--repo', repo]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('sprintdigest review --list, sprintdigest approve <id> or sprintdigest reject <id>');
  });

  it('says when there are no drafts', async () => {
    const repo = repoWithDrafts();
    await run(['approve', 'aaaa', '--repo', repo]);
    await run(['reject', 'bbbb', '--repo', repo]);
    expect((await run(['review', '--repo', repo], answers())).stdout).toContain('No drafts to review.');
  });
});
