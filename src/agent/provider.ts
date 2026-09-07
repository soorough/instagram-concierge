/**
 * The model, behind the narrowest interface that supports a real Agent Loop.
 *
 * It exists so tests can script an exact trajectory — "search, then add to cart,
 * then answer" — and assert the loop honoured it. Escalation in particular is
 * unreachable in a test without this: you cannot reliably provoke a real model
 * into spending its whole budget.
 *
 * It is deliberately thin. Anything richer would start making decisions that
 * belong to the loop, and the loop is the thing being graded.
 */

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

export type ToolUse = { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type Say = { kind: 'text'; text: string };
export type Step = ToolUse | Say;

export type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; steps: Step[] }
  | { role: 'tool_result'; id: string; content: string };

export type CompletionRequest = {
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
};

export type Completion = {
  steps: Step[];
  usage: { inputTokens: number; outputTokens: number };
};

export interface Provider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

/**
 * A Provider that replays a fixed script.
 *
 * Each entry is what the model "returns" on that call. Once the script runs out
 * it repeats its final entry, so a test that under-specifies fails by looping
 * rather than by throwing something unrelated.
 */
export class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  readonly requests: CompletionRequest[] = [];
  private index = 0;

  constructor(private readonly script: Step[][]) {}

  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push(request);
    const steps = this.script[Math.min(this.index, this.script.length - 1)] ?? [
      { kind: 'text', text: '' },
    ];
    this.index += 1;
    return { steps, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
