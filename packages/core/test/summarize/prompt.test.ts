import { describe, expect, it } from 'vitest';
import { chunkMessage, mergeSystemPrompt, PROMPT_VERSION, systemPrompt } from '../../src/summarize/prompt.js';

describe('summariser prompt', () => {
  it('is versioned', () => {
    expect(PROMPT_VERSION).toBe('summarize-v4');
  });

  it('contains the Section 6.1 prompt from PROJECT_PLAN.md verbatim, with the schema filled in', () => {
    const prompt = systemPrompt();
    for (const line of [
      'You are summarising one AI coding session for a team log.',
      'Input: a redacted, condensed transcript of a developer working with an AI coding agent, plus metadata (branch, files touched).',
      '- "whatWasDone": 2–5 plain sentences on what changed and why.',
      '- "decisions": only decisions that were actually made, each with its reason.',
      '- "rejectedApproaches": approaches tried or proposed then abandoned, with reasons. These are valuable, so include them.',
      '- "risksOrFollowUps": unfinished work, TODOs, known bugs, things to verify.',
      "- Don't invent anything that isn't in the transcript. If unsure, leave it out.",
      "- Don't include code, secrets, or redaction placeholders.",
      '- "aiInvolvement": light = Q&A/explanations, moderate = AI wrote parts, heavy = AI wrote most of the change.',
    ]) {
      expect(prompt).toContain(line);
    }
    expect(prompt).not.toContain('{schema}');
    // v2: a value chosen with a reason is a decision.
    expect(prompt).toContain('A value or setting chosen with a reason (a threshold, limit, timeout, version, library or config value) is a decision, not a follow-up.');
    expect(prompt).toContain('"reversedDecisions"');
    expect(prompt).toContain('"additionalProperties": false');
  });

  it('frames a chunk with metadata and its position', () => {
    const message = chunkMessage({ metadata: 'Agent: codex', chunk: 'USER: hi', part: 2, parts: 3, earlierDecisions: [] });
    expect(message).toBe('Session metadata:\nAgent: codex\n\nTranscript (part 2 of 3):\nUSER: hi');
  });

  it('lists earlier decisions with ids so a later part can reverse them', () => {
    const message = chunkMessage({ metadata: 'm', chunk: 'c', part: 2, parts: 2, earlierDecisions: [{ id: 'D1', decision: 'Use Redis' }] });
    expect(message).toContain('Decisions recorded in earlier parts:\nD1: Use Redis');
    expect(message).toContain('"reversedDecisions"');
  });
});

describe('merge prompt', () => {
  it('asks for at most 6 of the most durable items per list, one per duplicate group', () => {
    const prompt = mergeSystemPrompt();
    expect(prompt).toContain('at most 6');
    expect(prompt).toContain('most durable and important');
    expect(prompt).toContain('choose only one');
  });

  it('keeps both prompts about the work, not the process', () => {
    for (const prompt of [systemPrompt(), mergeSystemPrompt()]) {
      expect(prompt).toContain("Write about the session's work only: never mention the transcript, its parts, the metadata, summarising, or a team log.");
    }
  });
});
