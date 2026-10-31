import type { DigestInput, DigestWork } from './input.js';

// The stakeholder digest prompt (PROJECT_PLAN.md section 6.2), versioned for the digest cache key (DECISIONS.md D50).

export const DIGEST_PROMPT_VERSION = 'digest-v2';

const SECTION_6_2 = `You are writing a sprint update for a product owner or scrum master who is not technical.
Input: approved session summaries grouped by ticket, plus ticket titles.

Write markdown:
1. A 2–3 sentence overview of the period.
2. One short section per ticket: what was achieved, how AI was involved (light/moderate/heavy, in plain words), key decisions in plain language.
3. "Risks and open questions": a combined list.

Rules: no code, no file paths unless essential, no jargon without a short explanation, no judgement of individual developers, no invented facts.`;

export function digestSystemPrompt(): string {
  return `${SECTION_6_2}

Reply with a JSON object instead of markdown; it is turned into markdown for you:
- "overview": the 2–3 sentence overview.
- "tickets": one entry per ticket line in the input, using the first key on the line exactly (tickets listed on one line share their work and get one entry). "achieved": what was achieved, in one to three plain sentences. "aiInvolvement": one sentence on how AI was involved, in plain words. "keyDecisions": the key decisions in plain language, each with its reason; an empty list when there were none.
- "otherWork": one or two sentences on the work not linked to a ticket, or null when there is none.
- "risksAndOpenQuestions": the combined list of risks and open questions; an empty list when there are none.
Only mention ticket keys that appear in the input. Never write code, commands or code formatting. Never name or compare people.
The work is listed oldest first, with dates. A risk or follow-up from earlier work that later work shows as done, fixed or decided is resolved: leave it out.
Describe each ticket, and the overview, as things stood at the end of the period, not part-way through.
"risksAndOpenQuestions": only what a non-technical product owner could act on or should know about: delivery or scope at risk, quality problems people could notice, cost, and decisions they need to make. Leave out developer housekeeping (tests, tooling, versions, configuration, internal checks) and notes about how the work itself was recorded, reviewed or shared.`;
}

const list = (title: string, items: string[]) => (items.length ? [`  ${title}:`, ...items.map((i) => `    - ${i}`)] : []);
const work = (w: DigestWork, n: number) => [
  `W${n} (${w.from} to ${w.to}; ${w.tickets.length ? `tickets ${w.tickets.join(', ')}` : 'no ticket'}):`,
  `  Goal: ${w.goal}`,
  `  Outcome: ${w.outcome}`,
  `  What was done: ${w.whatWasDone}`,
  ...list('Decisions', w.decisions.map((d) => (d.reason ? `${d.decision} (because: ${d.reason})` : d.decision))),
  ...list('Rejected approaches', w.rejectedApproaches.map((r) => (r.reason ? `${r.approach} (because: ${r.reason})` : r.approach))),
  ...list('Risks or follow-ups', w.risksOrFollowUps),
  `  AI involvement: ${w.aiInvolvement}`,
];

export function digestMessage(input: DigestInput): string {
  const { summaryCount, developerCount } = input.coverage;
  const n = (w: DigestWork) => `W${input.timeline.indexOf(w) + 1}`;
  return [
    `Period: ${input.period.label}`,
    `Coverage: ${summaryCount} approved session summaries from ${developerCount} developers.`,
    '',
    'All work in this period, oldest first:',
    ...input.timeline.flatMap((w, i) => work(w, i + 1)),
    '',
    'Tickets:',
    ...input.tickets.map((t) => `Ticket ${t.keys.map((k, i) => `${k}${t.titles[i] ? `: ${t.titles[i]}` : ''}`).join(', ')} (AI involvement overall: ${t.aiInvolvement}): ${t.work.map(n).join(', ')}`),
    `Work not linked to a ticket: ${input.unlinked.length ? input.unlinked.map(n).join(', ') : 'none'}`,
  ].join('\n');
}
