import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TELEMETRY_FIELDS } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { parse } from '../../core/node_modules/yaml/dist/index.js';

// deploy/otel-collector.yaml (Phase 12, D107): the collector drops everything the server wouldn't read, so a misconfigured
// machine's prompts and commands go no further than it.

const file = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
const config = parse(file('deploy/otel-collector.yaml'));

describe('the collector configuration', () => {
  it('keeps exactly the fields the server reads, on records and on resources, and no body', () => {
    const statements = (config.processors['transform/allowlist'].log_statements as { context: string; statements: string[] }[]).flatMap((g) => g.statements.map((s) => `${g.context}: ${s}`));
    const list = `[${[...TELEMETRY_FIELDS].map((f) => `"${f}"`).join(', ')}]`;
    expect(statements).toEqual([`resource: keep_keys(resource.attributes, ${list})`, `log: keep_keys(log.attributes, ${list})`, 'log: set(log.body, "") where log.attributes["event.name"] != nil']);
  });

  it('passes on logs only, through the filter and the allowlist, as uncompressed JSON with the telemetry token', () => {
    expect(Object.keys(config.service.pipelines)).toEqual(['logs']);
    expect(config.service.pipelines.logs.processors).toEqual(['filter/usage', 'transform/allowlist']);
    expect(config.exporters.otlphttp).toMatchObject({ encoding: 'json', compression: 'none', headers: { Authorization: 'Bearer ${env:LOGS_TELEMETRY_TOKEN}' } });
  });

  it('is off unless asked for, and listens on this machine only by default', () => {
    const { collector } = parse(file('compose.yaml')).services;
    expect(collector.profiles).toEqual(['cost']);
    expect(collector.ports).toEqual(['${LOGS_OTLP_BIND:-127.0.0.1}:${LOGS_OTLP_PORT:-4318}:4318']);
  });
});
