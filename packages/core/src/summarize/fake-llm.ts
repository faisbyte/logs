import { estimateTokens } from './condense.js';
import { guardRequest, type LlmClient, type LlmRequest, type LlmResponse } from './llm.js';

type Script = string[] | ((request: LlmRequest, call: number) => string);

/** Deterministic stand-in for the API: unit tests and fake-pipeline evals never make a network call. */
export class FakeLlmClient implements LlmClient {
  readonly model: string;
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly script: Script,
    model = 'fake-model',
  ) {
    this.model = model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    guardRequest(request);
    const call = this.requests.length;
    this.requests.push(request);
    const text = typeof this.script === 'function' ? this.script(request, call) : this.script[call];
    if (text === undefined) throw new Error(`FakeLlmClient script has no reply for call ${call + 1}`);
    const prompt = request.system + request.messages.map((m) => m.content).join('\n');
    return { text, usage: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text) }, stopReason: 'end_turn' };
  }
}
