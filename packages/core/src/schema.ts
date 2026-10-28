import { z } from 'zod';

export const AgentSchema = z.enum(['claude-code', 'codex']);
export type Agent = z.infer<typeof AgentSchema>;

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

export const ToolStatusSchema = z.enum(['ok', 'error', 'rejected', 'unknown']);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const TranscriptEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), timestamp, text: z.string() }),
  z.object({ kind: z.literal('assistant'), timestamp, text: z.string() }),
  z.object({ kind: z.literal('reasoning'), timestamp, text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    timestamp,
    callId: z.string(),
    name: z.string(),
    /** One-line summary of the call (command, path, url). Never file contents. */
    input: z.string(),
    filePaths: z.array(z.string()),
    output: z.string().nullable(),
    outputTruncated: z.boolean(),
    status: ToolStatusSchema,
    /** Shell commands only: the exit status when the agent recorded it. */
    exitCode: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal('interruption'), timestamp }),
]);
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;
export type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>;

/** A Claude Code subagent, kept compact: what it was asked, what it reported, what it changed. */
export const SubagentSchema = z.object({
  agentType: z.string().nullable(),
  description: z.string().nullable(),
  prompt: z.string().nullable(),
  finalText: z.string().nullable(),
  filesTouched: z.array(z.string()),
  toolCallCount: count,
});
export type Subagent = z.infer<typeof SubagentSchema>;

export const ParsedSessionSchema = z
  .object({
    agent: AgentSchema,
    sourceSessionId: z.string().min(1),
    sourcePath: z.string().min(1),
    agentVersions: z.array(z.string()),
    title: z.string().nullable(),
    /** Launch cwd: the first cwd the session recorded. */
    cwd: z.string().min(1),
    /** Branch at launch. */
    gitBranch: z.string().nullable(),
    gitBranches: z.array(z.string()),
    startedAt: timestamp,
    endedAt: timestamp,
    models: z.array(z.string()),
    /** Human prompts only; injected context and tool results don't count. */
    turnCount: count,
    /** Includes tool calls made by subagents. */
    toolCallCount: count,
    filesTouched: z.array(z.string()),
    commitShas: z.array(z.string()),
    subagents: z.array(SubagentSchema),
    transcript: z.array(TranscriptEntrySchema),
  })
  .refine((s) => Date.parse(s.endedAt) >= Date.parse(s.startedAt), {
    message: 'endedAt must not be before startedAt',
    path: ['endedAt'],
  });
export type ParsedSession = z.infer<typeof ParsedSessionSchema>;
