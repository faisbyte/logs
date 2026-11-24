import { createHash } from 'node:crypto';
import type { Agent } from '../schema.js';
import { normalizeRemoteUrl } from '../shared/repo-id.js';

// Reads AI usage from OpenTelemetry log batches (DECISIONS.md D106, D107). Agents' telemetry can hold prompts, commands
// and tool output. Only the fields named here are ever read, each only in its expected shape, so nothing else can be kept.

/** One model request, as an agent reported it. */
export interface UsageEvent {
  /** Identifies the request, so one sent twice counts once. A hash: it holds nothing readable. */
  key: string;
  at: string;
  agent: Agent;
  /** The signed-in account's email, lowercase. */
  account: string;
  organizationId: string | null;
  sessionId: string;
  model: string;
  /** Not counting tokens read from or written to the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The agent's own estimate, in millionths of a US dollar; null when it sends none. */
  costMicros: number | null;
  billing: 'api' | 'subscription' | null;
  /** The session's repo (host/path), when the agent reports a hosted remote. */
  repoId: string | null;
}

type Attributes = Map<string, string | number>;

const MAX_COUNT = 1e12;
const SESSION = /^[\w.:-]{1,200}$/;
const MODEL = /^[\w.:/@[\]-]{1,100}$/;
const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{1,50}$/;
const ID = /^[\w-]{1,100}$/;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const field = (value: unknown, name: string): unknown => (value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined);

function read(into: Attributes, raw: unknown): Attributes {
  for (const a of list(raw)) {
    const [key, value] = [field(a, 'key'), field(a, 'value')];
    const v = field(value, 'stringValue') ?? field(value, 'intValue') ?? field(value, 'doubleValue');
    if (typeof key === 'string' && (typeof v === 'string' || typeof v === 'number')) into.set(key, v);
  }
  return into;
}

const matching = (a: Attributes, key: string, shape: RegExp) => {
  const v = a.get(key);
  return typeof v === 'string' && shape.test(v) ? v : null;
};

/** A count or amount: null when absent, undefined when it is there but can't be right. */
function amount(a: Attributes, key: string): number | null | undefined {
  const v = a.get(key);
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_COUNT ? n : undefined;
}

function timeOf(a: Attributes, record: unknown): string | null {
  const stamp = a.get('event.timestamp');
  if (typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(stamp) && !Number.isNaN(Date.parse(stamp))) return new Date(stamp).toISOString();
  for (const key of ['timeUnixNano', 'observedTimeUnixNano']) {
    const ms = Number(field(record, key)) / 1e6;
    if (Number.isFinite(ms) && ms > 0 && ms < 8.64e15) return new Date(ms).toISOString();
  }
  return null;
}

const key = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function claudeCode(a: Attributes, at: string): UsageEvent | null {
  const sessionId = matching(a, 'session.id', SESSION);
  const counts = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'].map((k) => amount(a, k));
  const micros = amount(a, 'cost_usd_micros');
  const dollars = amount(a, 'cost_usd');
  const shared = common(a);
  if (!sessionId || !shared || micros === undefined || dollars === undefined || counts.includes(undefined)) return null;
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = counts.map((n) => Math.round(n ?? 0)) as [number, number, number, number];
  const request = a.get('request_id') ?? a.get('client_request_id');
  const url = a.get('vcs.repository.url.full');
  return {
    key: request ? key('claude-code', request) : key('claude-code', sessionId, at, a.get('event.sequence'), shared.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
    at,
    agent: 'claude-code',
    ...shared,
    sessionId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costMicros: micros !== null ? Math.round(micros) : dollars !== null ? Math.round(dollars * 1e6) : null,
    billing: null,
    repoId: typeof url === 'string' ? normalizeRemoteUrl(url) : null,
  };
}

/** Codex reports neither a cost nor a repo, and its input count includes cached tokens. */
function codex(a: Attributes, at: string): UsageEvent | null {
  const sessionId = matching(a, 'conversation.id', SESSION);
  const counts = ['input_token_count', 'output_token_count', 'cached_token_count', 'cache_write_token_count'].map((k) => amount(a, k));
  const shared = common(a);
  if (!sessionId || !shared || counts.includes(undefined)) return null;
  const [input, outputTokens, cacheReadTokens, cacheWriteTokens] = counts.map((n) => Math.round(n ?? 0)) as [number, number, number, number];
  const auth = String(a.get('auth_mode') ?? '').toLowerCase();
  return {
    key: key('codex', sessionId, at, input, outputTokens, cacheReadTokens, cacheWriteTokens),
    at,
    agent: 'codex',
    ...shared,
    sessionId,
    inputTokens: Math.max(0, input - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costMicros: null,
    billing: auth === 'apikey' ? 'api' : auth === 'chatgpt' ? 'subscription' : null,
    repoId: null,
  };
}

function common(a: Attributes): Pick<UsageEvent, 'account' | 'organizationId' | 'model'> | null {
  const account = matching(a, 'user.email', EMAIL);
  const model = matching(a, 'model', MODEL);
  return account && model ? { account: account.toLowerCase(), organizationId: matching(a, 'organization.id', ID), model } : null;
}

function usageEvent(resource: unknown, record: unknown): UsageEvent | null {
  const a = read(read(new Map(), resource), field(record, 'attributes'));
  const body = field(field(record, 'body'), 'stringValue');
  const name = String(a.get('event.name') ?? field(record, 'eventName') ?? body ?? '').replace(/^claude_code\./, '');
  const at = timeOf(a, record);
  if (!at) return null;
  if (name === 'api_request') return claudeCode(a, at);
  if (name === 'codex.sse_event' && a.get('event.kind') === 'response.completed') return codex(a, at);
  return null;
}

/** The usage in an OTLP/JSON log batch, and how many other records were ignored; null when it isn't one. */
export function usageEvents(body: unknown): { events: UsageEvent[]; ignored: number } | null {
  const resources = field(body, 'resourceLogs');
  if (!Array.isArray(resources)) return null;
  const events: UsageEvent[] = [];
  let ignored = 0;
  for (const r of resources) {
    const resource = field(field(r, 'resource'), 'attributes');
    for (const record of list(field(r, 'scopeLogs')).flatMap((s) => list(field(s, 'logRecords')))) {
      const event = usageEvent(resource, record);
      if (event) events.push(event);
      else ignored++;
    }
  }
  return { events, ignored };
}
