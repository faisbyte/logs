import { describe, expect, it } from 'vitest';
import { usageEvents } from '../../src/cost/telemetry.js';
import { claudeRequest, codexCompleted, logBatch } from './otlp.js';

// Phase 12 (DECISIONS.md D106, D107): what is taken from agent telemetry. Only an allowlist of fields is ever read.

const one = (record: Record<string, string | number | boolean>) => usageEvents(logBatch(record))!.events[0];

describe('usageEvents', () => {
  it('reads a Claude Code API request', () => {
    expect(one(claudeRequest())).toEqual({
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
      at: '2026-04-07T10:00:00.000Z',
      agent: 'claude-code',
      account: 'alice@acme.example',
      organizationId: 'org-acme',
      sessionId: 'c0000001-0000-4000-8000-000000000001',
      model: 'claude-opus-5-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 300,
      costMicros: 250_000,
      billing: null,
      repoId: 'github.com/acme/webapp',
    });
  });

  it('reads a Codex completed response: no cost or repo, and cached input counted once', () => {
    expect(one(codexCompleted())).toMatchObject({ agent: 'codex', account: 'bob@acme.example', organizationId: null, sessionId: 'd0000001-0000-4000-8000-000000000001', model: 'gpt-test', inputTokens: 400, cacheReadTokens: 600, outputTokens: 200, cacheWriteTokens: 0, costMicros: null, billing: 'subscription', repoId: null });
    expect(one(codexCompleted({ auth_mode: 'ApiKey' }))).toMatchObject({ billing: 'api' });
  });

  it('never carries anything outside the allowlist, whatever the batch holds', () => {
    const planted = ['fix the login bug', 'rm -rf /tmp/secret-dir', 'alices-laptop', 'acc-1', 'a tool result'];
    const batch = logBatch(
      claudeRequest({ prompt: planted[0]!, full_command: planted[1]!, tool_parameters: `{"bash_command":"${planted[1]}"}` }),
      { 'event.name': 'user_prompt', prompt: planted[0]!, 'session.id': 's' },
      { 'event.name': 'tool_result', tool_input: planted[1]!, 'session.id': 's' },
      { 'event.name': 'codex.tool_result', arguments: planted[1]!, output: planted[4]! },
    );
    const result = usageEvents(batch)!;
    expect(result.events).toHaveLength(1);
    expect(result.ignored).toBe(3);
    for (const text of planted) expect(JSON.stringify(result)).not.toContain(text);
  });

  it('refuses free text in the fields it does read', () => {
    expect(one(claudeRequest({ 'session.id': 'please delete the users table' }))).toBeUndefined();
    expect(one(claudeRequest({ model: 'a model with spaces and text' }))).toBeUndefined();
    expect(one(claudeRequest({ 'user.email': 'not an address' }))).toBeUndefined();
    expect(one(claudeRequest({ 'organization.id': 'some long sentence' }))).toMatchObject({ organizationId: null });
  });

  it('gives the same request the same key when it is sent twice, and different requests different keys', () => {
    expect(one(claudeRequest())!.key).toBe(one(claudeRequest({ 'event.timestamp': '2026-04-07T10:00:05.000Z' }))!.key);
    expect(one(claudeRequest())!.key).not.toBe(one(claudeRequest({ request_id: 'req_2' }))!.key);
    const noId = claudeRequest();
    delete (noId as Record<string, unknown>).request_id;
    expect(one(noId)!.key).toBe(one(noId)!.key);
    expect(one(noId)!.key).not.toBe(one({ ...noId, 'event.sequence': 4 })!.key);
    expect(one(codexCompleted())!.key).not.toBe(one(codexCompleted({ output_token_count: '201' }))!.key);
  });

  it('accepts cost as dollars when micros are missing, and negative or absurd numbers not at all', () => {
    const dollars = claudeRequest({ cost_usd: '0.5' });
    delete (dollars as Record<string, unknown>).cost_usd_micros;
    expect(one(dollars)).toMatchObject({ costMicros: 500_000 });
    expect(one(claudeRequest({ cost_usd_micros: -1 }))).toBeUndefined();
    expect(one(claudeRequest({ input_tokens: 1e15 }))).toBeUndefined();
    const free = claudeRequest();
    delete (free as Record<string, unknown>).cost_usd_micros;
    delete (free as Record<string, unknown>).cost_usd;
    expect(one(free)).toMatchObject({ costMicros: null });
  });

  it('falls back to the record time, and drops an event with no account, session or time', () => {
    const untimed = claudeRequest();
    delete (untimed as Record<string, unknown>)['event.timestamp'];
    expect(one(untimed)).toMatchObject({ at: '2026-04-07T10:00:00.000Z' });
    for (const field of ['user.email', 'session.id', 'model'] as const) {
      const without = claudeRequest();
      delete (without as Record<string, unknown>)[field];
      expect(one(without)).toBeUndefined();
    }
  });

  it('reads the event name from the body, with its claude_code prefix, and attributes from the resource', () => {
    const { 'event.name': _, 'user.email': email, ...rest } = claudeRequest();
    const batch = logBatch(rest) as { resourceLogs: { resource: { attributes: unknown[] }; scopeLogs: { logRecords: { body: unknown }[] }[] }[] };
    batch.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.body = { stringValue: 'claude_code.api_request' };
    batch.resourceLogs[0]!.resource.attributes.push({ key: 'user.email', value: { stringValue: email } });
    expect(usageEvents(batch)!.events).toMatchObject([{ account: 'alice@acme.example' }]);
  });

  it('keeps a session without a hosted remote as having no repo', () => {
    expect(one(claudeRequest({ 'vcs.repository.url.full': '/Users/alice/private' }))).toMatchObject({ repoId: null });
  });

  it('answers null for something that is not an OTLP log batch', () => {
    for (const body of [null, 'x', [], { resourceLogs: 'x' }, { resourceSpans: [] }]) expect(usageEvents(body)).toBeNull();
    expect(usageEvents({ resourceLogs: [] })).toEqual({ events: [], ignored: 0 });
    expect(usageEvents({ resourceLogs: [null, { scopeLogs: [{ logRecords: [null, { attributes: 'x' }] }] }] })).toEqual({ events: [], ignored: 2 });
  });
});
