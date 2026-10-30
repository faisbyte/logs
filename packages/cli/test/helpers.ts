import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmRequest } from '@digest/core';
import { llmSummary } from '../../core/test/summarize/helpers.js';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
export const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Copies every fixture session, rewriting /work/acme-webapp to a temp repo the CLI can write .digest/ into. */
export function fixtureRepo() {
  const repo = tempDir('digest-sum-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const home = tempDir('digest-sum-agents-');
  cpSync(join(FIXTURES, 'claude-code'), join(home, 'claude'), { recursive: true });
  cpSync(join(FIXTURES, 'codex'), join(home, 'codex'), { recursive: true });
  const rewrite = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) rewrite(path);
      else if (name.endsWith('.jsonl')) writeFileSync(path, readFileSync(path, 'utf8').replaceAll('/work/acme-webapp', repo));
    }
  };
  rewrite(home);
  return { repo, env: { CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') } };
}

export const reply = (request: LlmRequest) =>
  request.system.startsWith('You are merging')
    ? JSON.stringify({ goal: 'g', whatWasDone: 'w', aiInvolvement: 'moderate', decisionIds: [], rejectedApproachIds: [], followUpIds: [] })
    : JSON.stringify(llmSummary());

