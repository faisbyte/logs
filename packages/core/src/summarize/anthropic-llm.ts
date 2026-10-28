import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { guardRequest, type LlmClient, type LlmRequest, type LlmResponse } from './llm.js';
import type { Effort } from './settings.js';

/** The slice of the SDK this client uses; tests stand it in for the network. */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export class MissingApiKeyError extends Error {}

/** The real model. Only redacted, condensed text reaches it (guardRequest), using the developer's own key. */
export class AnthropicLlmClient implements LlmClient {
  readonly #messages: MessagesApi;

  constructor(
    readonly model: string,
    readonly effort: Effort,
    messages: MessagesApi,
  ) {
    this.#messages = messages;
  }

  /** Reads ANTHROPIC_API_KEY from the environment; the key is never stored where it can be printed. */
  static fromEnv(env: Record<string, string | undefined>, model: string, effort: Effort): AnthropicLlmClient {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new MissingApiKeyError('ANTHROPIC_API_KEY is not set. Export your Anthropic API key in your shell (export ANTHROPIC_API_KEY=...) and run again.');
    }
    return new AnthropicLlmClient(model, effort, new Anthropic({ apiKey }).messages);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    guardRequest(request);
    // Haiku 5.5 and newer reject temperature/top_p/top_k and assistant prefill; JSON comes from structured outputs.
    const response = await this.#messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort: this.effort, format: zodOutputFormat(request.schema) },
    });
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      text,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      stopReason: response.stop_reason,
    };
  }
}
