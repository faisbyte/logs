import type { z } from 'zod';
import { assertRedactedSession, type RedactedSession } from '../redact/session.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /** Provenance: every client hard-checks that this is a real redactSession() result (DECISIONS.md D16, D23). */
  readonly source: RedactedSession;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  /** Structured-output schema for the reply. */
  readonly schema: z.ZodType;
  readonly maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  stopReason: string | null;
}

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** First line of every LlmClient.complete(): throws unless the request comes from a RedactedSession. */
export function guardRequest(request: LlmRequest): void {
  assertRedactedSession(request.source);
}
