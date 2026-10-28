import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexFile } from '../src/parsers/codex.js';
import { ParsedSessionSchema } from '../src/schema.js';
import { codex, REPO } from './fixtures.js';

describe('parseCodexFile', () => {
  describe('metadata', () => {
    const session = parseCodexFile(codex.basic)!;

    it('produces a session that satisfies the schema', () => {
      expect(ParsedSessionSchema.parse(session)).toEqual(session);
    });

    it('identifies the agent, session and source file', () => {
      expect(session.agent).toBe('codex');
      expect(session.sourceSessionId).toBe('019c0001-0000-7000-8000-000000000001');
      expect(session.sourcePath).toBe(codex.basic);
    });

    it('takes cwd, branch and CLI version from session_meta', () => {
      expect(session.cwd).toBe(REPO);
      expect(session.gitBranch).toBe('feature/PROJ-142-rate-limit');
      expect(session.gitBranches).toEqual(['feature/PROJ-142-rate-limit']);
      expect(session.agentVersions).toEqual(['0.81.0-alpha.8']);
    });

    it('takes models from turn_context', () => {
      expect(session.models).toEqual(['gpt-5.2-codex']);
    });

    it('spans the first to the last event, in UTC', () => {
      expect(session.startedAt).toBe('2026-03-02T10:00:00.000Z');
      expect(session.endedAt).toBe(JSON.parse(readFileSync(codex.basic, 'utf8').trimEnd().split('\n').at(-1)!).timestamp);
    });

    it('has no title or subagents and leaves commit SHAs for the git step', () => {
      expect(session.title).toBeNull();
      expect(session.subagents).toEqual([]);
      expect(session.commitShas).toEqual([]);
    });
  });

  describe('user prompts', () => {
    it('strips the IDE context template and skips injected AGENTS.md and environment context', () => {
      const session = parseCodexFile(codex.basic)!;
      expect(session.transcript.filter((e) => e.kind === 'user').map((e) => 'text' in e && e.text)).toEqual([
        'Add a unit test for the login rate limiter.',
      ]);
      expect(session.turnCount).toBe(1);
    });

    it('skips environment_context user messages in 0.45 sessions', () => {
      expect(parseCodexFile(codex.long)!.turnCount).toBe(25);
    });

    it('keeps prompts sent without the IDE template verbatim and records aborted turns', () => {
      const messy = parseCodexFile(codex.messy)!;
      expect(messy.transcript.filter((e) => e.kind === 'user').map((e) => 'text' in e && e.text)).toEqual([
        'Add live updates to the dashboard using websockets.',
        "Stop. Don't use websockets, the proxy blocks them. Plain polling every 10s is fine.",
      ]);
      expect(messy.transcript.filter((e) => e.kind === 'interruption')).toHaveLength(1);
    });

    it('handles a session with a prompt and no response', () => {
      const empty = parseCodexFile(codex.empty)!;
      expect(ParsedSessionSchema.safeParse(empty).success).toBe(true);
      expect(empty.turnCount).toBe(1);
      expect(empty.transcript.filter((e) => e.kind === 'assistant')).toEqual([]);
    });
  });

  describe('assistant output and tool calls', () => {
    const basic = parseCodexFile(codex.basic)!;
    const messy = parseCodexFile(codex.messy)!;

    it('keeps the conversation in order without event_msg duplicates', () => {
      const lines = basic.transcript.map((e) =>
        e.kind === 'tool' ? `${e.name}(${e.input}) ${e.status}` : `${e.kind}: ${'text' in e ? e.text : ''}`,
      );
      expect(lines).toEqual([
        'user: Add a unit test for the login rate limiter.',
        'reasoning: **Planning limiter test**\n\nRead the middleware, then add a vitest file.',
        'shell(sed -n 1,80p src/middleware/rateLimit.ts) ok',
        'apply_patch(test/rateLimit.test.ts) ok',
        'shell(pnpm vitest run test/rateLimit.test.ts) ok',
        'assistant: Added test/rateLimit.test.ts covering the limit, the window reset, and per-IP isolation. All 3 tests pass.',
      ]);
      expect(basic.toolCallCount).toBe(3);
    });

    it('unwraps shell output and maps a non-zero exit code to an error', () => {
      const add = messy.transcript.find((e) => e.kind === 'tool' && e.input === 'pnpm add ws');
      expect(add).toMatchObject({ status: 'error', exitCode: 1, output: expect.stringContaining('ERR_PNPM_FETCH_403') });
      expect(basic.transcript.find((e) => e.kind === 'tool' && e.name === 'shell')).toMatchObject({ exitCode: 0 });
      expect(messy.transcript.find((e) => e.kind === 'tool' && e.name === 'apply_patch')).toMatchObject({ exitCode: 0 });
    });

    it('treats an apply_patch heredoc inside shell as an apply_patch call, without the patch body', () => {
      const long = parseCodexFile(codex.long)!;
      const patch = long.transcript.find((e) => e.kind === 'tool' && e.name === 'apply_patch');
      expect(patch).toMatchObject({ input: 'packages/api/src/admin/settings.ts', status: 'ok' });
      expect(long.transcript.filter((e) => e.kind === 'tool' && e.name === 'apply_patch')).toHaveLength(8);
    });
  });

  describe('files touched', () => {
    it('resolves apply_patch paths against the session cwd', () => {
      expect(parseCodexFile(codex.basic)!.filesTouched).toEqual([`${REPO}/test/rateLimit.test.ts`]);
    });

    it('includes added, updated and deleted files, once each', () => {
      expect(parseCodexFile(codex.messy)!.filesTouched).toEqual([
        `${REPO}/src/dashboard/index.ts`,
        `${REPO}/src/live/poll.ts`,
        `${REPO}/src/live/socket.ts`,
      ]);
    });

    it('includes files patched through shell heredocs', () => {
      const long = parseCodexFile(codex.long)!;
      expect(long.filesTouched).toHaveLength(8);
      expect(long.filesTouched).toContain(`${REPO}/packages/api/src/admin/users.ts`);
    });
  });

  describe('damaged or empty files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'digest-codex-'));
    const write = (name: string, text: string) => {
      const file = join(tmp, name);
      writeFileSync(file, text);
      return file;
    };

    it('ignores a half-written last line', () => {
      const file = write('partial.jsonl', `${readFileSync(codex.basic, 'utf8').trimEnd()}\n{"timestamp":"2026-03-0`);
      expect(parseCodexFile(file)?.turnCount).toBe(1);
    });

    it('returns null for a file without session_meta', () => {
      expect(parseCodexFile(write('nometa.jsonl', '{"timestamp":"2026-03-02T10:00:00.000Z","type":"turn_context","payload":{}}\n'))).toBeNull();
    });
  });
});
