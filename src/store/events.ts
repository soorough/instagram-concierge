import type { DB } from './db.ts';

/**
 * Claims an Event for processing exactly once.
 *
 * Returns true the first time an Event id is seen and false forever after. The
 * claim is an INSERT against a primary key, so uniqueness is enforced by the
 * database rather than by a read-then-write that two concurrent Deliveries could
 * both pass.
 *
 * Meta redelivers on any failure, and retries arrive immediately rather than
 * politely spaced. The rule this encodes is that losing a reply is better than
 * sending two — a Customer who gets silence will message again, whereas a
 * Customer who gets the same answer twice learns the account is automated.
 *
 * For an Opener the rule is stronger than a preference. The platform grants one
 * Private Reply per comment, permanently, so a duplicate is not an annoyance but
 * an unrecoverable loss of the only message that comment will ever earn.
 */
export function claimEvent(db: DB, eventId: string, kind: string, now = Date.now()): boolean {
  const result = db
    .prepare('insert or ignore into processed_event (event_id, kind, received_at) values (?, ?, ?)')
    .run(eventId, kind, now);
  return result.changes === 1;
}

