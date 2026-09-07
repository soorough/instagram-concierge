import { runTurn, type TurnResult } from './agent/loop.ts';
import { openerPrompt, systemPrompt } from './agent/prompt.ts';
import type { Provider } from './agent/provider.ts';
import type { Dispatcher } from './channel/dispatcher.ts';
import type { Enricher } from './channel/enrich.ts';
import type { InboundComment, InboundEvent, InboundMessage } from './channel/parse.ts';
import type { McpClient } from './mcp/client.ts';
import {
  alreadyDecided,
  decideOpener,
  recordDecision,
  type OpenerDecision,
} from './opener/policy.ts';
import {
  appendMessage,
  cartIdFor,
  ensureConversation,
  hasConversation,
  historyFor,
  recordToolCall,
  recordTurn,
  rememberCart,
  withinReplyWindow,
} from './store/conversation.ts';
import type { DB } from './store/db.ts';

/**
 * Turns one Event into one reply, or into a recorded reason for silence.
 *
 * This is the only place the two workflows meet, and they differ in exactly one
 * respect: a message continues a Conversation, while a comment must first earn
 * the single Opener it will ever be granted. Everything after that decision —
 * the Agent Loop, the Tools, the Dispatcher — is shared.
 */

export type ConciergeDeps = {
  db: DB;
  mcp: McpClient;
  provider: Provider;
  dispatcher: Dispatcher;
  /** Fetches the commenter's profile and the post, for the Opener. */
  enricher: Enricher;
  brandName: string;
  /** The brand's own standing instructions, in their words. Optional. */
  brandInstructions?: string;
  brandAccountIds: readonly string[];
  toolBudget: number;
  log?: (line: string) => void;
};

export type Handled =
  | { outcome: 'replied'; text: string; turn: TurnResult }
  | { outcome: 'opened'; text: string; turn: TurnResult }
  | { outcome: 'withheld'; reason: string }
  | { outcome: 'window_closed'; reason: string }
  | { outcome: 'send_failed'; reason: string };

export function createConcierge(deps: ConciergeDeps) {
  const log = deps.log ?? (() => {});

  return async function handle(event: InboundEvent): Promise<Handled> {
    return event.kind === 'message' ? handleMessage(event) : handleComment(event);
  };

  async function handleMessage(event: InboundMessage): Promise<Handled> {
    ensureConversation(deps.db, event.customerId, undefined, event.at);

    // History is read before the new message is stored, so the model sees the
    // Conversation as it stood when the Customer wrote.
    const history = historyFor(deps.db, event.customerId);
    appendMessage(deps.db, event.customerId, 'customer', event.text, event.at);

    /**
     * The Cart is carried in from the Conversation, so "add one more" extends
     * what they already chose. Without it every Turn starts a fresh cart and the
     * checkout link silently loses everything from earlier messages.
     */
    const cartId = cartIdFor(deps.db, event.customerId);

    const turn = await runTurn({
      provider: deps.provider,
      system: systemPrompt(deps.brandName, deps.brandInstructions),
      history: [...history, { role: 'user', content: event.text }],
      context: { mcp: deps.mcp, ...(cartId ? { cartId } : {}) },
      toolBudget: deps.toolBudget,
    });

    persistTurn(event.customerId, event.eventId, 'message', turn);
    if (turn.cartId) rememberCart(deps.db, event.customerId, turn.cartId);

    /**
     * Instagram closes the thread 24 hours after the Customer last wrote. A Turn
     * delayed by a slow Tool or a restart can land outside it, and the platform
     * answers that with an error rather than a warning — so it is checked here,
     * and a closed window is reported rather than thrown away silently.
     */
    if (!withinReplyWindow(deps.db, event.customerId)) {
      const reason = 'the 24-hour reply window has closed';
      log(`cannot reply to ${event.customerId}: ${reason}`);
      return { outcome: 'window_closed', reason };
    }

    const sent = await deps.dispatcher.sendMessage(event.customerId, turn.reply);
    if (!sent.ok) {
      log(`send failed for ${event.customerId}: ${sent.reason}`);
      return { outcome: 'send_failed', reason: sent.reason };
    }

    appendMessage(deps.db, event.customerId, 'concierge', turn.reply);
    return { outcome: 'replied', text: turn.reply, turn };
  }

  async function handleComment(event: InboundComment): Promise<Handled> {
    /**
     * A comment's allowance is spent the moment it is decided, whichever way the
     * decision went. Re-deciding after a restart would hand back a chance the
     * platform will not honour, so the record is authoritative over the policy.
     */
    if (alreadyDecided(deps.db, event.eventId)) {
      return { outcome: 'withheld', reason: 'this comment has already been decided' };
    }

    const decision: OpenerDecision = decideOpener({
      comment: event,
      brandAccountIds: deps.brandAccountIds,
      hasConversation: hasConversation(deps.db, event.customerId),
    });

    if (decision.decision === 'withhold') {
      recordDecision(deps.db, event, decision);
      log(`opener withheld for ${event.eventId}: ${decision.reason}`);
      return { outcome: 'withheld', reason: decision.reason };
    }

    /**
     * Written before the send is attempted, not after. A crash between sending
     * and recording would burn the only Private Reply this comment will ever
     * allow and leave nothing to show for it — so the record is made first and a
     * failed send is reported rather than retried into a second attempt.
     */
    recordDecision(deps.db, event, decision);

    /**
     * The brief's pipeline is comment → fetch profile → compose opener, so the
     * fetch is attempted rather than skipped. It usually fails: the User Profile
     * API is consent-gated and a commenter has given no consent. The refusal is
     * carried into the prompt as a stated unknown, and the post — which is the
     * brand's own media and therefore readable — supplies the specificity the
     * profile could not.
     */
    const enrichment = await deps.enricher.forComment(event.customerId, event.mediaId);
    if (enrichment.profileUnavailable) {
      log(`profile unavailable for ${event.customerId}: ${enrichment.profileUnavailable}`);
    }

    const turn = await runTurn({
      provider: deps.provider,
      system: openerPrompt(deps.brandName, event, enrichment, deps.brandInstructions),
      history: [
        { role: 'user', content: `They commented: "${event.text}". Write the opener.` },
      ],
      context: { mcp: deps.mcp },
      toolBudget: deps.toolBudget,
    });

    persistTurn(event.customerId, event.eventId, 'comment', turn);

    const sent = await deps.dispatcher.sendPrivateReply(event.eventId, turn.reply);
    if (!sent.ok) {
      log(`opener send failed for ${event.eventId}: ${sent.reason}`);
      return { outcome: 'send_failed', reason: sent.reason };
    }

    /**
     * The Conversation begins here, seeded with what they said in public and
     * what we replied — so their next message continues a thread rather than
     * arriving as a stranger's.
     */
    ensureConversation(deps.db, event.customerId, event.username, event.at);
    appendMessage(deps.db, event.customerId, 'customer', event.text, event.at);
    appendMessage(deps.db, event.customerId, 'concierge', turn.reply);

    return { outcome: 'opened', text: turn.reply, turn };
  }

  /**
   * One Turn, then its Tool calls pointing at it. Written even when the send
   * afterwards fails — what the Concierge decided is worth keeping regardless of
   * whether the platform accepted it.
   */
  function persistTurn(
    customerId: string,
    eventId: string,
    kind: 'message' | 'comment',
    turn: TurnResult,
  ): void {
    const turnId = recordTurn(deps.db, customerId, {
      eventId,
      kind,
      modelCalls: turn.modelCalls,
      modelMs: turn.modelMs,
      toolMs: turn.toolMs,
      escalated: turn.escalated,
      reply: turn.reply,
    });
    for (const entry of turn.trace) recordToolCall(deps.db, customerId, turnId, entry);
    if (turn.escalated) log(`escalated for ${customerId} after ${turn.trace.length} tool calls`);
  }
}
