import Anthropic from '@anthropic-ai/sdk';
import type {
  Completion,
  CompletionRequest,
  Provider,
  Step,
  Turn,
} from './provider.ts';

/**
 * The real model.
 *
 * This file translates between our Turn vocabulary and the Messages API and does
 * nothing else. No retry policy, no prompt assembly, no tool selection — those
 * belong to the loop, and burying them here would make the loop untestable and
 * this class untrue to its name.
 */

const MODEL = process.env.MODEL_NAME ?? 'claude-sonnet-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 1024);

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: request.system,
      messages: toMessages(request.turns),
      ...(request.tools.length > 0 ? { tools: request.tools } : {}),
    });

    const steps: Step[] = response.content.flatMap((block): Step[] => {
      if (block.type === 'text') return [{ kind: 'text', text: block.text }];
      if (block.type === 'tool_use') {
        return [
          {
            kind: 'tool_use',
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          },
        ];
      }
      // Thinking and other block types carry no instruction for the loop.
      return [];
    });

    return {
      steps,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

/**
 * Tool results must be attached to the assistant message that requested them,
 * matched by id, and they arrive as `user` messages in this API. Consecutive
 * results are merged into one message because the API rejects a `user` turn that
 * follows another `user` turn.
 */
function toMessages(turns: Turn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content });
      continue;
    }

    if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.steps.map((step) =>
          step.kind === 'text'
            ? ({ type: 'text', text: step.text } as const)
            : ({ type: 'tool_use', id: step.id, name: step.name, input: step.input } as const),
        ),
      });
      continue;
    }

    const block = {
      type: 'tool_result' as const,
      tool_use_id: turn.id,
      content: turn.content,
    };
    const previous = messages.at(-1);
    if (previous?.role === 'user' && Array.isArray(previous.content)) {
      previous.content.push(block);
    } else {
      messages.push({ role: 'user', content: [block] });
    }
  }

  return messages;
}
