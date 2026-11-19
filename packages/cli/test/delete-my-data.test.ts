import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySummaryStore, localPushTarget } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { contextItem } from '../../core/test/shared/context-contract.js';
import { payloadFor } from '../../core/test/shared/store-contract.js';
import { runCli, type CliIo } from '../src/cli.js';

// sprintdigest delete-my-data (DECISIONS.md D98).

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

async function setup(role: 'developer' | 'reader' = 'developer') {
  const store = new InMemorySummaryStore();
  await store.push(alice, payloadFor({ sessionId: 'a1' }));
  await store.push(alice, payloadFor({ sessionId: 'a2' }));
  await store.applyContextChanges(REPO_ID, { added: [contextItem({ repoId: REPO_ID, sources: ['claude-code/a1'] })], merged: [], superseded: [] });
  const pushTarget = localPushTarget(store, (await store.issueToken(alice, role)).token);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-delete-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/WebApp.git'], { cwd: repo });
  return { store, pushTarget, repo };
}

describe('sprintdigest delete-my-data', () => {
  it('says what it would delete and deletes nothing without --yes', async () => {
    const { store, pushTarget, repo } = await setup();
    const result = await run(['delete-my-data', '--repo', repo], { pushTarget });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'sprintdigest delete-my-data: this permanently deletes every summary you pushed to github.com/acme/webapp, and what was made only from them ' +
        '(context items, and the text of digests that included them). It cannot be undone. Run it again with --yes to go ahead.\n',
    );
    expect(await store.list({ repoId: REPO_ID })).toHaveLength(2);
  });

  it('deletes with --yes and says what went', async () => {
    const { store, pushTarget, repo } = await setup();
    expect(await run(['delete-my-data', '--repo', repo, '--yes'], { pushTarget })).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: [
        'Deleted your data on github.com/acme/webapp:',
        '  2 summaries',
        '  0 ticket links',
        '  1 context item deleted, 0 edited',
        '  0 digests withdrawn, 0 deleted',
        "Your summaries in .digest/ on this machine are untouched, and won't be pushed again.",
        '',
      ].join('\n'),
    });
    expect(await store.list({ repoId: REPO_ID })).toEqual([]);
  });

  it("passes on the store's refusal", async () => {
    const { pushTarget, repo } = await setup('reader');
    expect(await run(['delete-my-data', '--repo', repo, '--yes'], { pushTarget })).toMatchObject({
      exitCode: 1,
      stderr: 'sprintdigest delete-my-data: the store refused the token: reader tokens can read digests and reports only\n',
    });
  });
});
