import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
export const CLAUDE_PROJECTS = `${FIXTURES}claude-code/projects`;
export const CODEX_SESSIONS = `${FIXTURES}codex/sessions`;
export const REPO = '/work/acme-webapp';

export const claude = {
  basic: `${CLAUDE_PROJECTS}/-work-acme-webapp/c1a5e001-0000-4000-8000-000000000001.jsonl`,
  messy: `${CLAUDE_PROJECTS}/-work-acme-webapp/c1a5e002-0000-4000-8000-000000000002.jsonl`,
  long: `${CLAUDE_PROJECTS}/-work-acme-webapp-packages-api/c1a5e003-0000-4000-8000-000000000003.jsonl`,
  other: `${CLAUDE_PROJECTS}/-work-acme-webapp-legacy/c1a5e004-0000-4000-8000-000000000004.jsonl`,
};

export const codex = {
  basic: `${CODEX_SESSIONS}/2026/03/02/rollout-2026-03-02T21-00-00-019c0001-0000-7000-8000-000000000001.jsonl`,
  long: `${CODEX_SESSIONS}/2026/03/06/rollout-2026-03-06T11-30-00-019c0002-0000-7000-8000-000000000002.jsonl`,
  messy: `${CODEX_SESSIONS}/2026/03/07/rollout-2026-03-07T10-00-00-019c0003-0000-7000-8000-000000000003.jsonl`,
  empty: `${CODEX_SESSIONS}/2026/03/07/rollout-2026-03-07T11-00-05-019c0004-0000-7000-8000-000000000004.jsonl`,
  other: `${CODEX_SESSIONS}/2026/03/08/rollout-2026-03-08T13-00-00-019c0005-0000-7000-8000-000000000005.jsonl`,
};

/** Eval-only sessions, outside the discovered folders so they don't change what `digest list` finds. */
export const evalOnly = {
  early: `${FIXTURES}eval/claude-code/c1a5e005-0000-4000-8000-000000000005.jsonl`,
};

/** Every fixture by golden name, e.g. "claude.messy" or "eval.early". */
export const fixtureFiles: Record<string, string> = Object.fromEntries([
  ...Object.entries(claude).map(([k, v]) => [`claude.${k}`, v]),
  ...Object.entries(codex).map(([k, v]) => [`codex.${k}`, v]),
  ...Object.entries(evalOnly).map(([k, v]) => [`eval.${k}`, v]),
]);
