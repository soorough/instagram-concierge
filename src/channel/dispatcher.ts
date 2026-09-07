/**
 * Outbound. The only place that talks back to Instagram.
 *
 * Two platform rules are enforced here rather than trusted to callers, because
 * both are unrecoverable when broken.
 *
 * The text limit is 1000 **bytes**, not characters. A reply of 400 emoji is
 * under any character limit and over this one, and the platform rejects the
 * whole send rather than truncating it.
 *
 * A comment grants exactly one Private Reply, ever. Not one per session, per
 * day, or per deploy: one. So the Dispatcher refuses a second attempt on a
 * comment it has already answered, and the record of that lives in the database
 * rather than in memory — a restart must not hand back a fresh allowance.
 */

export type SendResult =
  | { ok: true; messageId: string; recipientId?: string }
  | { ok: false; reason: string; retryable: boolean };

export interface Dispatcher {
  /** Reply inside an open Conversation, addressed by Customer. */
  sendMessage(customerId: string, text: string): Promise<SendResult>;
  /** Send the one Opener a comment allows, addressed by the comment itself. */
  sendPrivateReply(commentId: string, text: string): Promise<SendResult>;
}

export const TEXT_LIMIT_BYTES = 1000;

/** Trims to the byte limit on a character boundary, never mid-codepoint. */
export function fitToLimit(text: string, limit = TEXT_LIMIT_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;

  const ellipsis = '…';
  const budget = limit - Buffer.byteLength(ellipsis, 'utf8');
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > budget) break;
    out += char;
  }
  return out.trimEnd() + ellipsis;
}

export class InstagramDispatcher implements Dispatcher {
  constructor(
    private readonly accessToken: string,
    private readonly apiBase = 'https://graph.instagram.com/v25.0',
    private readonly timeoutMs = 20_000,
  ) {}

  sendMessage(customerId: string, text: string): Promise<SendResult> {
    return this.post({ recipient: { id: customerId }, message: { text: fitToLimit(text) } });
  }

  sendPrivateReply(commentId: string, text: string): Promise<SendResult> {
    return this.post({ recipient: { comment_id: commentId }, message: { text: fitToLimit(text) } });
  }

  private async post(body: unknown): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBase}/me/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.accessToken}`,
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      const payload = (await res.json()) as {
        message_id?: string;
        recipient_id?: string;
        error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean };
      };

      if (payload.error) {
        /**
         * Subcode 2534066 is the one this project meets constantly: "insufficient
         * granular scope for private reply, or invalid comment id". It is not
         * retryable — it means the app lacks Advanced Access — so retrying just
         * burns quota. See docs/platform-findings.md §7.
         */
        const subcode = payload.error.error_subcode;
        return {
          ok: false,
          reason: `${payload.error.message ?? 'send failed'}${subcode ? ` (subcode ${subcode})` : ''}`,
          retryable: payload.error.is_transient === true,
        };
      }

      return {
        ok: true,
        messageId: payload.message_id ?? '',
        ...(payload.recipient_id ? { recipientId: payload.recipient_id } : {}),
      };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      return { ok: false, reason: aborted ? 'timed out' : (error as Error).message, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A Dispatcher that records instead of sending.
 *
 * It is what the demo runs on, because outbound is gated while the app holds
 * Standard Access, and it is what the tests assert against. Keeping it in the
 * source tree rather than the test folder is deliberate: it is a supported mode
 * of the system, not a testing convenience, and the README says so.
 */
export class RecordingDispatcher implements Dispatcher {
  readonly sent: { to: string; kind: 'message' | 'private_reply'; text: string }[] = [];

  async sendMessage(customerId: string, text: string): Promise<SendResult> {
    const fitted = fitToLimit(text);
    this.sent.push({ to: customerId, kind: 'message', text: fitted });
    return { ok: true, messageId: `recorded-${this.sent.length}` };
  }

  async sendPrivateReply(commentId: string, text: string): Promise<SendResult> {
    const fitted = fitToLimit(text);
    this.sent.push({ to: commentId, kind: 'private_reply', text: fitted });
    return { ok: true, messageId: `recorded-${this.sent.length}` };
  }
}
