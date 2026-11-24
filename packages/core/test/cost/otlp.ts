// Hand-written OTLP/JSON log batches in the shapes Claude Code documents and Codex's source emits. No real content.
type Value = string | number | boolean;
export const attributes = (values: Record<string, Value>) =>
  Object.entries(values).map(([key, v]) => ({
    key,
    value: typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
  }));

export const logBatch = (...records: Record<string, Value>[]) => ({
  resourceLogs: [
    {
      resource: { attributes: attributes({ 'service.name': 'test', 'host.name': 'alices-laptop' }) },
      scopeLogs: [{ logRecords: records.map((r) => ({ timeUnixNano: '1775556000000000000', body: { stringValue: String(r['event.name'] ?? '') }, attributes: attributes(r) })) }],
    },
  ],
});

export const claudeRequest = (over: Record<string, Value> = {}) => ({
  'event.name': 'api_request',
  'event.timestamp': '2026-04-07T10:00:00.000Z',
  'event.sequence': 3,
  'session.id': 'c0000001-0000-4000-8000-000000000001',
  'organization.id': 'org-acme',
  'user.email': 'alice@acme.example',
  'user.account_uuid': 'acc-1',
  'vcs.repository.url.full': 'https://github.com/acme/webapp',
  model: 'claude-opus-5-5',
  cost_usd: 0.25,
  cost_usd_micros: 250_000,
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 2000,
  cache_creation_tokens: 300,
  request_id: 'req_1',
  ...over,
});

export const codexCompleted = (over: Record<string, Value> = {}) => ({
  'event.name': 'codex.sse_event',
  'event.kind': 'response.completed',
  'event.timestamp': '2026-04-07T11:00:00.000Z',
  'conversation.id': 'd0000001-0000-4000-8000-000000000001',
  'user.email': 'bob@acme.example',
  'user.account_id': 'acct-bob',
  auth_mode: 'Chatgpt',
  model: 'gpt-test',
  input_token_count: '1000',
  output_token_count: '200',
  cached_token_count: 600,
  cache_write_token_count: 0,
  reasoning_token_count: 50,
  ...over,
});
