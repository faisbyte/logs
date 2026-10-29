import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { parseCodexFile } from '../../src/parsers/codex.js';
import { redactSession } from '../../src/redact/session.js';
import { chunkTurns, condenseSession, estimateTokens } from '../../src/summarize/condense.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { SessionSummarySchema } from '../../src/summarize/schema.js';
import { summarizeCached } from '../../src/summarize/store.js';
import { fixtureFiles } from '../fixtures.js';
import { asLlmReply, compareToGolden, goldens } from './compare.js';
import { pickAll } from './helpers.js';

const parse = (fixture: string) => (parseClaudeCodeFile(fixtureFiles[fixture]!) ?? parseCodexFile(fixtureFiles[fixture]!))!;
const settings = { model: 'claude-haiku-5-5', effort: 'low' as const, chunkTokens: 60_000 };

describe('fake-LLM pipeline against the goldens', () => {
  it.each(goldens().map((g) => [g.fixture, g]))('%s: parse, redact, condense, summarise, store, compare', async (_name, golden) => {
    const repo = mkdtempSync(join(tmpdir(), 'digest-pipeline-'));
    const parsed = parse(golden.fixture);
    const llm = new FakeLlmClient([JSON.stringify(asLlmReply(golden))], 'claude-haiku-5-5');
    await summarizeCached(repo, redactSession(parsed), llm, settings);

    // What was sent: the condensed transcript, starting with the first prompt.
    const firstPrompt = parsed.transcript.find((e) => e.kind === 'user');
    expect(llm.requests[0]!.messages[0]!.content).toContain(firstPrompt && 'text' in firstPrompt ? firstPrompt.text.slice(0, 40) : '');

    // What was stored: a valid draft matching the golden, with metadata from the session.
    const draft = SessionSummarySchema.parse(
      JSON.parse(readFileSync(join(repo, '.digest/summaries', `${parsed.agent}-${parsed.sourceSessionId}.json`), 'utf8')),
    );
    expect(draft.status).toBe('draft');
    expect(draft.filesTouched).toEqual(parsed.filesTouched.map((p) => p.replace(`${parsed.cwd}/`, '')));
    expect(compareToGolden(draft, golden)).toEqual({ missingDecisions: [], missingRejectedApproaches: [], rejectedListedAsDecision: [], forbiddenMentions: [] });
  });

  it('claude.messy in parts: the early Redis decision, reversed later, ends up rejected', async () => {
    const golden = goldens().find((g) => g.fixture === 'claude.messy')!;
    const reply = asLlmReply(golden);
    const redacted = redactSession(parse('claude.messy'));
    const chunkTokens = estimateTokens(condenseSession(redacted).turns[0]!);
    expect(chunkTurns(condenseSession(redacted).turns, chunkTokens).length).toBeGreaterThan(1);

    const llm = new FakeLlmClient((request) => {
      const content = request.messages[0]!.content;
      if (request.system.startsWith('You are merging')) return pickAll(request, { goal: reply.goal, whatWasDone: reply.whatWasDone, aiInvolvement: reply.aiInvolvement });
      if (/Transcript \(part 1 of/.test(content)) return JSON.stringify({ ...reply, decisions: [{ decision: 'Put a Redis cache in front of search', reason: 'Queries run per keystroke.' }], rejectedApproaches: [], risksOrFollowUps: [] });
      if (content.includes('USER: No Redis')) return JSON.stringify({ ...reply, rejectedApproaches: [], reversedDecisions: [{ id: 'D1', reason: "Ops won't run another service.", evidence: 'No Redis' }] });
      return JSON.stringify({ ...reply, decisions: [], rejectedApproaches: [], risksOrFollowUps: [] });
    }, 'claude-haiku-5-5');

    const repo = mkdtempSync(join(tmpdir(), 'digest-pipeline-'));
    const { summary } = await summarizeCached(repo, redacted, llm, { ...settings, chunkTokens });
    expect(compareToGolden(summary, golden)).toEqual({ missingDecisions: [], missingRejectedApproaches: [], rejectedListedAsDecision: [], forbiddenMentions: [] });
  });
});
