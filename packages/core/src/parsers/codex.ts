import { resolve } from 'node:path';
import type { ParsedSession, ToolEntry, TranscriptEntry } from '../schema.js';
import { distinct, readJsonl } from './jsonl.js';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown> & { type?: string };
}

interface TextBlock {
  type?: string;
  text?: string;
}

// The VS Code extension wraps typed prompts in an IDE-context template; the prompt follows this header.
const IDE_REQUEST_HEADER = '## My request for Codex:';
const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function promptText(message: string): string {
  const at = message.lastIndexOf(IDE_REQUEST_HEADER);
  return (at >= 0 ? message.slice(at + IDE_REQUEST_HEADER.length) : message).trim();
}

const patchPaths = (patch: string) => distinct([...patch.matchAll(PATCH_FILE_HEADER)].map((m) => m[1]?.trim()));

function shellScript(command: unknown): string {
  if (!Array.isArray(command)) return str(command) ?? '';
  // ["bash", "-lc", "<script>"] is how Codex wraps every shell call.
  if (command.length === 3 && command[1] === '-lc') return String(command[2]);
  return command.join(' ');
}

function unwrapOutput(output: string): { text: string; exitCode: number | null } {
  try {
    const parsed = JSON.parse(output) as { output?: unknown; metadata?: { exit_code?: unknown } };
    if (typeof parsed.output === 'string') {
      return { text: parsed.output, exitCode: typeof parsed.metadata?.exit_code === 'number' ? parsed.metadata.exit_code : null };
    }
  } catch {
    // plain-text output
  }
  return { text: output, exitCode: null };
}

function toolCall(payload: Record<string, unknown>, cwd: string): Omit<ToolEntry, 'kind' | 'timestamp' | 'callId'> {
  const base = { output: null, outputTruncated: false, status: 'unknown' as const };
  const name = str(payload.name) ?? 'unknown';
  const patchCall = (patch: string, workdir: string) => {
    const paths = patchPaths(patch);
    return { ...base, name: 'apply_patch', input: paths.join(', '), filePaths: paths.map((p) => resolve(workdir, p)) };
  };

  if (payload.type === 'custom_tool_call') {
    return name === 'apply_patch' ? patchCall(str(payload.input) ?? '', cwd) : { ...base, name, input: str(payload.input) ?? '', filePaths: [] };
  }

  const raw = str(payload.arguments) ?? '';
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // keep raw
  }
  if (name === 'shell') {
    const script = shellScript(args.command);
    const workdir = str(args.workdir) ?? cwd;
    if (/^\s*apply_patch\b/.test(script)) return patchCall(script, workdir);
    return { ...base, name, input: script, filePaths: [] };
  }
  return { ...base, name, input: raw, filePaths: [] };
}

export function parseCodexFile(path: string): ParsedSession | null {
  const lines = readJsonl<CodexLine>(path);
  const meta = lines.find((l) => l.type === 'session_meta')?.payload;
  const sessionId = str(meta?.id);
  const launchCwd = str(meta?.cwd);
  if (!meta || !sessionId || !launchCwd) return null;

  const git = (meta.git ?? {}) as { branch?: unknown };
  const transcript: TranscriptEntry[] = [];
  const toolsById = new Map<string, ToolEntry>();
  const models: string[] = [];
  let cwd = launchCwd;

  for (const { timestamp = '', type, payload } of lines) {
    if (!payload) continue;
    const kind = payload.type;

    if (type === 'turn_context') {
      cwd = str(payload.cwd) ?? cwd;
      models.push(str(payload.model) ?? '');
    }

    if (type === 'event_msg' && kind === 'user_message') {
      const message = str(payload.message) ?? '';
      if (payload.kind === 'environment_context' || message.trimStart().startsWith('<environment_context>')) continue;
      transcript.push({ kind: 'user', timestamp, text: promptText(message) });
    }
    if (type === 'event_msg' && kind === 'turn_aborted') transcript.push({ kind: 'interruption', timestamp });

    if (type !== 'response_item') continue;
    if (kind === 'message' && payload.role === 'assistant') {
      const text = ((payload.content ?? []) as TextBlock[]).map((b) => b.text ?? '').join('\n').trim();
      if (text) transcript.push({ kind: 'assistant', timestamp, text });
    }
    if (kind === 'reasoning') {
      const text = ((payload.summary ?? []) as TextBlock[]).map((b) => b.text ?? '').join('\n').trim();
      if (text) transcript.push({ kind: 'reasoning', timestamp, text });
    }
    if (kind === 'function_call' || kind === 'custom_tool_call') {
      const callId = str(payload.call_id) ?? `call-${toolsById.size}`;
      const entry: ToolEntry = { kind: 'tool', timestamp, callId, ...toolCall(payload, cwd) };
      toolsById.set(callId, entry);
      transcript.push(entry);
    }
    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const entry = toolsById.get(str(payload.call_id) ?? '');
      if (!entry) continue;
      const { text, exitCode } = unwrapOutput(str(payload.output) ?? '');
      entry.output = text;
      entry.status = exitCode === null || exitCode === 0 ? 'ok' : 'error';
    }
  }

  const tools = [...toolsById.values()];
  const edits = tools.filter((t) => t.name === 'apply_patch' && t.status === 'ok');
  const times = lines.map((l) => l.timestamp).filter((t): t is string => !!t).sort();
  const branch = str(git.branch) ?? null;

  return {
    agent: 'codex',
    sourceSessionId: sessionId,
    sourcePath: path,
    agentVersions: distinct([str(meta.cli_version)]),
    title: null,
    cwd: launchCwd,
    gitBranch: branch,
    gitBranches: distinct([branch]),
    startedAt: times[0]!,
    endedAt: times.at(-1)!,
    models: distinct(models),
    turnCount: transcript.filter((e) => e.kind === 'user').length,
    toolCallCount: tools.length,
    filesTouched: distinct(edits.flatMap((t) => t.filePaths)).sort(),
    commitShas: [],
    subagents: [],
    transcript,
  };
}
