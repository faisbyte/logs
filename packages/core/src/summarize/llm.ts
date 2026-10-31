import type { z } from 'zod';
import type { ContextInput } from '../context/input.js';
import { assertLlmSource, type DigestInput } from '../digest/input.js';
import type { RedactedSession } from '../redact/session.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /** Provenance: every client hard-checks that this is a real redactSession() or digestInput() result (DECISIONS.md D16, D23, D49). */
  readonly source: RedactedSession | DigestInput | ContextInput;
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

/** First line of every LlmClient.complete(): throws unless the request comes from a RedactedSession or a DigestInput. */
export function guardRequest(request: LlmRequest): void {
  assertLlmSource(request.source);
}
