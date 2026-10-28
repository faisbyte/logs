import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeCodeFile } from './parsers/claude-code.js';
import { parseCodexFile } from './parsers/codex.js';
import type { Agent, ParsedSession } from './schema.js';

export interface AgentDirs {
  claudeProjectsDir: string;
  codexSessionsDir: string;
}

export interface SessionFile {
  agent: Agent;
  path: string;
}

/** Where each agent keeps sessions, honouring the agents' own config-dir overrides. */
export function agentDirs(env: Record<string, string | undefined>, homeDir: string): AgentDirs {
  return {
    claudeProjectsDir: join(env.CLAUDE_CONFIG_DIR ?? join(homeDir, '.claude'), 'projects'),
    codexSessionsDir: join(env.CODEX_HOME ?? join(homeDir, '.codex'), 'sessions'),
  };
}

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []);

function walk(dir: string): string[] {
  return entries(dir).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

export function discoverSessionFiles(dirs: AgentDirs): SessionFile[] {
  // Claude Code: <projects>/<encoded-cwd>/<session>.jsonl; subagent files sit one level deeper.
  const claude = entries(dirs.claudeProjectsDir)
    .filter((e) => e.isDirectory())
    .flatMap((project) =>
      entries(join(dirs.claudeProjectsDir, project.name))
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
        .map((f): SessionFile => ({ agent: 'claude-code', path: join(dirs.claudeProjectsDir, project.name, f.name) })),
    );
  // Codex: <sessions>/YYYY/MM/DD/rollout-*.jsonl
  const codex = walk(dirs.codexSessionsDir)
    .filter((p) => /\/rollout-[^/]*\.jsonl$/.test(p))
    .map((path): SessionFile => ({ agent: 'codex', path }));
  return [...claude, ...codex];
}

export function loadSessions(files: SessionFile[]): ParsedSession[] {
  return files
    .map((f) => (f.agent === 'claude-code' ? parseClaudeCodeFile(f.path) : parseCodexFile(f.path)))
    .filter((s): s is ParsedSession => s !== null);
}
