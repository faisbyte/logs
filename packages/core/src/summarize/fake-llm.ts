import { estimateTokens } from './condense.js';
import { guardRequest, type LlmClient, type LlmRequest, type LlmResponse } from './llm.js';

type Reply = string | { text: string; stopReason: string };
type Script = Reply[] | ((request: LlmRequest, call: number) => Reply);

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
    const reply = typeof this.script === 'function' ? this.script(request, call) : this.script[call];
    if (reply === undefined) throw new Error(`FakeLlmClient script has no reply for call ${call + 1}`);
    const { text, stopReason } = typeof reply === 'string' ? { text: reply, stopReason: 'end_turn' } : reply;
    const prompt = request.system + request.messages.map((m) => m.content).join('\n');
    return { text, usage: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text) }, stopReason };
  }
}
