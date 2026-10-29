import { describe, expect, it } from 'vitest';
import { digestInput } from '../../src/digest/input.js';
import { judgeDigest, judgeSystemPrompt } from '../../src/digest/judge.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { ticketReport } from '../../src/shared/ticket-report.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { payloadFor } from '../shared/store-contract.js';

// The faithfulness judge (DECISIONS.md D56): lists the digest's claims and flags those the summaries don't support.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };

describe('judgeDigest', () => {
  it('sends the summaries and the digest, and returns the unsupported claims', async () => {
    const store = new InMemorySummaryStore();
    await store.push(alice, payloadFor());
    const input = digestInput(await ticketReport(store, REPO, { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' }));
    const reply = {
      claims: [
        { claim: 'Login now limits repeated attempts.', supported: true, reason: 'Work 1 added a limiter.' },
        { claim: 'The change shipped to production.', supported: false, reason: 'No summary mentions a release.' },
      ],
    };
    const llm = new FakeLlmClient([JSON.stringify(reply)], 'claude-opus-5-5');
    const verdict = await judgeDigest(input, '# Update\n\nLogin now limits repeated attempts. The change shipped to production.\n', llm);
    expect(verdict).toMatchObject({ claimCount: 2, unsupported: [{ claim: 'The change shipped to production.', reason: 'No summary mentions a release.' }], usage: { requests: 1 } });
    const sent = llm.requests[0]!;
    expect(sent.source).toBe(input);
    expect(sent.messages[0]!.content).toContain('Ticket PROJ-142');
    expect(sent.messages[0]!.content).toContain('The change shipped to production.');
  });

  it('asks for every factual claim, judged only against the summaries', () => {
    expect(judgeSystemPrompt()).toContain('List every factual claim the digest makes');
    expect(judgeSystemPrompt()).toContain('supported only if the summaries state it or plainly imply it');
  });
});
