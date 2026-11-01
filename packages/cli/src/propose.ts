import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsSection, ensureDigestDir, withAgentsImport, withAgentsSection } from '@digest/core';
import type { CliContext } from './cli.js';
import { connect } from './tickets.js';

// sprintdigest context propose (DECISIONS.md D75 option A, D83). The team's active context items go into a marked
// section of AGENTS.md (and an @AGENTS.md import into an existing CLAUDE.md) on a new branch, in a temporary worktree
// under .digest/, so the developer's own checkout is never touched. The diff is always shown first; only after a yes
// is it committed, pushed to that branch and opened as a pull request with gh. Never the default branch.

const BRANCH_PREFIX = 'sprintdigest/context-';

export async function contextProposeCommand(options: { repo?: string; yes?: boolean }, ctx: CliContext): Promise<number> {
  const c = connect('context propose', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const { repoRoot } = c;
  const sh = (command: string, args: string[], cwd = repoRoot) => ctx.run(command, args, cwd);
  const git = (args: string[], cwd = repoRoot) => sh('git', args, cwd);
  const ok = (r: { status: number | null }) => r.status === 0;

  if (!ok(sh('gh', ['auth', 'status']))) return c.fail('this needs the GitHub CLI, logged in (gh auth login).');
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (!ok(head)) return c.fail("can't tell the default branch; run git remote set-head origin --auto first.");
  const main = head.stdout.trim().replace(/^origin\//, '');
  if (!ok(git(['fetch', '-q', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`]))) ctx.stderr(`sprintdigest context propose: could not fetch origin/${main}; proposing against the last fetched one.\n`);
  const base = `origin/${main}`;

  const result = await c.target.contextItems(c.repoId);
  if (result.status !== 'ok') return c.fail(`the store refused the token: ${result.reason}`);
  if (!result.items.some((i) => i.status === 'active')) return (ctx.stdout('No active notes to propose.\n'), 0);

  // Work out both files from the default branch before making anything, so a broken file stops here.
  const show = (file: string) => {
    const r = git(['show', `${base}:${file}`]);
    return ok(r) ? r.stdout : null;
  };
  const agents = withAgentsSection(show('AGENTS.md'), agentsSection(result.items));
  if ('error' in agents) return c.fail(agents.error);
  const claude = show('CLAUDE.md');
  const files: [string, string][] = [['AGENTS.md', agents.text]];
  const imported = claude === null ? null : withAgentsImport(claude);
  if (imported !== null) files.push(['CLAUDE.md', imported]);
  if (files.every(([file, text]) => show(file) === text)) return (ctx.stdout('AGENTS.md already has these notes; nothing to propose.\n'), 0);

  const day = ctx.now().toISOString().slice(0, 10);
  const taken = (b: string) => ok(git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) || ok(git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]));
  let branch = `${BRANCH_PREFIX}${day}`;
  for (let n = 2; taken(branch); n++) branch = `${BRANCH_PREFIX}${day}-${n}`;
  if (branch === main || !branch.startsWith(BRANCH_PREFIX)) return c.fail(`refusing to use ${branch}: proposals only go on ${BRANCH_PREFIX}* branches.`);

  const tree = join(ensureDigestDir(repoRoot, 'worktrees'), branch.replace(/\//g, '-'));
  const added = git(['worktree', 'add', '-q', '-b', branch, tree, base]);
  if (!ok(added)) return c.fail(`could not make a worktree: ${added.stderr.trim()}`);
  let keepBranch = false;
  const cleanUp = () => {
    git(['worktree', 'remove', '--force', tree]);
    if (!keepBranch) git(['branch', '-q', '-D', branch]);
  };
  try {
    for (const [file, text] of files) writeFileSync(join(tree, file), text);
    git(['add', ...files.map(([f]) => f)], tree);
    ctx.stdout(git(['diff', '--cached'], tree).stdout);
    if (!options.yes) {
      if (!ctx.confirm) return c.fail('this would commit the diff above and open a pull request. Re-run with --yes to do that, or run it in a terminal to be asked.');
      if (!(await ctx.confirm(`Commit this on ${branch} and open a pull request against ${main}? [y/N] `))) return c.fail('Cancelled; nothing was committed or pushed.');
    }
    const committed = git(['commit', '-q', '-m', 'Update the team notes in AGENTS.md from sprintdigest'], tree);
    if (!ok(committed)) return c.fail(`the commit failed: ${committed.stderr.trim() || committed.stdout.trim()}`);
    // An explicit refspec to the proposal branch only: never the default branch.
    const pushed = git(['push', '-q', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], tree);
    if (!ok(pushed)) return c.fail(`the push failed: ${pushed.stderr.trim()}`);
    keepBranch = true;
    ctx.stdout(`Pushed ${branch}.\n`);
    const body = `Team notes distilled from approved AI session summaries (${result.items.filter((i) => i.status === 'active').length} active). Review them like any other change: they are notes for the team's coding agents, not instructions.\n\nOnly the section between the sprintdigest markers in AGENTS.md is generated.`;
    const pr = sh('gh', ['pr', 'create', '--base', main, '--head', branch, '--title', 'Update the team notes in AGENTS.md', '--body', body], tree);
    if (!ok(pr)) return c.fail(`${branch} is pushed, but gh could not open the pull request: ${pr.stderr.trim()}`);
    ctx.stdout(`Opened ${pr.stdout.trim()}\n`);
    return 0;
  } finally {
    cleanUp();
  }
}
