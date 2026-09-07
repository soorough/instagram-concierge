import type { Provider, Step, ToolUse, Turn } from './provider.ts';
import { executeTool, toolsFor, type ToolContext } from './tools.ts';

/**
 * The Agent Loop.
 *
 * The model reasons, chooses Tools, reads what they returned, and decides again.
 * Nothing here inspects the Customer's words to route them: there is no keyword
 * table, no intent classifier, no branch on "if the message mentions shipping".
 * Which Tool to call, and whether to call one at all, is the model's decision on
 * every pass. That is the property the brief asks for, and the reason this file
 * has no conditionals about content.
 *
 * What the loop *does* own is the budget. A model that keeps finding one more
 * thing to check turns a fixed-cost Turn into an unbounded one, and the cost
 * tail is what makes per-Conversation pricing unpredictable. So Tool calls are
 * counted, the budget is stated in the prompt so the model can pace itself, and
 * exhausting it produces Escalation rather than a guess.
 */

export const ESCALATION =
  "I want to get this exactly right and I'm not certain yet — let me get a person from the team to pick this up with you.";

export type TraceEntry = {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: string;
  durationMs: number;
};

export type TurnResult = {
  reply: string;
  /** Every Tool call in order, with what it returned. The audit trail for any reply. */
  trace: TraceEntry[];
  /** True when the budget ran out before the model had an answer. */
  escalated: boolean;
  modelCalls: number;
  /** Time inside the model, separated from time inside Tools. */
  modelMs: number;
  toolMs: number;
  /** The Cart this Turn worked on, so the Conversation can carry it forward. */
  cartId?: string;
  checkoutUrl?: string;
};

export type RunTurnOptions = {
  provider: Provider;
  system: string;
  /** Prior Conversation, oldest first. The new Customer message is appended by the caller. */
  history: Turn[];
  context: ToolContext;
  toolBudget: number;
};

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { provider, system, context, toolBudget } = options;
  const turns: Turn[] = [...options.history];
  const trace: TraceEntry[] = [];

  let modelCalls = 0;
  let modelMs = 0;
  let cartId = context.cartId;
  let checkoutUrl: string | undefined;

  /**
   * One pass per model call. The bound is the budget plus one: the final
   * iteration exists so a model that has just received its last Tool result
   * still gets a chance to answer from it, rather than being escalated for
   * spending exactly what it was allowed.
   */
  for (let pass = 0; pass <= toolBudget; pass += 1) {
    const remaining = toolBudget - trace.length;
    const modelStarted = Date.now();
    const completion = await provider.complete({
      system: `${system}\n\nTool calls remaining this turn: ${remaining}.`,
      turns,
      // Offering no tools on the final pass is what forces an answer rather than
      // another request the loop would have to refuse. And only ever offer what
      // this store can serve — a tool that must fail is worse than absent.
      tools: remaining > 0 ? toolsFor(context.mcp) : [],
    });
    modelMs += Date.now() - modelStarted;
    modelCalls += 1;

    const calls = completion.steps.filter(isToolUse);
    if (calls.length === 0) {
      const reply = completion.steps
        .filter((s): s is Extract<Step, { kind: 'text' }> => s.kind === 'text')
        .map((s) => s.text)
        .join('')
        .trim();

      return {
        reply: reply || ESCALATION,
        trace,
        escalated: reply.length === 0,
        modelCalls,
        modelMs,
        toolMs: trace.reduce((n, t) => n + t.durationMs, 0),
        ...(cartId ? { cartId } : {}),
        ...(checkoutUrl ? { checkoutUrl } : {}),
      };
    }

    turns.push({ role: 'assistant', steps: completion.steps });

    /**
     * Calls arrive one at a time even when the model asks for several, so it
     * learns what the first returned before the second is spent. A model that
     * fires three speculative searches in parallel wastes a budget it could
     * have spent on one good search and a cart.
     */
    for (const call of calls) {
      if (trace.length >= toolBudget) {
        turns.push({
          role: 'tool_result',
          id: call.id,
          content: 'Budget exhausted. Answer with what you already know, or say you cannot.',
        });
        continue;
      }

      const started = Date.now();
      const outcome = await executeTool(call.name, call.input, { ...context, ...(cartId ? { cartId } : {}) });
      if (outcome.cart) {
        cartId = outcome.cart.id;
        checkoutUrl = outcome.cart.checkoutUrl;
      }
      const entry: TraceEntry = {
        tool: call.name,
        input: call.input,
        ok: outcome.ok,
        result: outcome.text,
        durationMs: Date.now() - started,
      };
      trace.push(entry);
      turns.push({ role: 'tool_result', id: call.id, content: outcome.text });
    }
  }

  // Every pass asked for another Tool and the budget is gone. Say so honestly.
  return {
    reply: ESCALATION,
    trace,
    escalated: true,
    modelCalls,
    modelMs,
    toolMs: trace.reduce((n, t) => n + t.durationMs, 0),
    ...(cartId ? { cartId } : {}),
    ...(checkoutUrl ? { checkoutUrl } : {}),
  };
}

const isToolUse = (step: Step): step is ToolUse => step.kind === 'tool_use';
