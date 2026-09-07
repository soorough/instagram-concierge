import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, type DB } from '../src/store/db.ts';
import {
  acceptRequest,
  ensureConversation,
  openRequest,
  requestState,
} from '../src/store/conversation.ts';

/**
 * Instagram's message request, modelled.
 *
 * An Opener is a Private Reply, and a Private Reply does not land in a thread —
 * it lands in the recipient's message requests, where nothing is delivered
 * onward until they accept. So "the Opener was sent" is not the same claim as
 * "the Customer is reachable", and a system that conflates them will happily
 * queue a second message to someone who has never opened the first.
 *
 * Acceptance is not a button we can see. What the platform gives us is their
 * reply: a Customer who writes back has, by definition, accepted. That makes
 * their first inbound message the transition, and it is the only signal the
 * platform actually offers.
 */
const fresh = (): DB => {
  const db = new Database(':memory:') as unknown as DB;
  migrate(db);
  return db;
};

describe('the message request', () => {
  it('has no state before an opener is sent', () => {
    const db = fresh();
    expect(requestState(db, 'cust-1')).toBe('none');
  });

  it('is pending once the opener goes out', () => {
    const db = fresh();
    ensureConversation(db, 'cust-1', 'slittone');
    openRequest(db, 'cust-1');
    expect(requestState(db, 'cust-1')).toBe('pending');
  });

  it('is accepted when the customer writes back', () => {
    const db = fresh();
    ensureConversation(db, 'cust-1', 'slittone');
    openRequest(db, 'cust-1');
    acceptRequest(db, 'cust-1');
    expect(requestState(db, 'cust-1')).toBe('accepted');
  });

  it('stays accepted — acceptance is not something they take back by going quiet', () => {
    const db = fresh();
    ensureConversation(db, 'cust-1', 'slittone');
    openRequest(db, 'cust-1');
    acceptRequest(db, 'cust-1');
    acceptRequest(db, 'cust-1');
    expect(requestState(db, 'cust-1')).toBe('accepted');
  });

  it('does not reopen a request for someone already talking to us', () => {
    /**
     * A second comment from an accepted Customer must not drop them back into
     * the requests folder — the opener policy withholds for exactly this case,
     * and the state has to agree with it.
     */
    const db = fresh();
    ensureConversation(db, 'cust-1', 'slittone');
    openRequest(db, 'cust-1');
    acceptRequest(db, 'cust-1');
    openRequest(db, 'cust-1');
    expect(requestState(db, 'cust-1')).toBe('accepted');
  });
});
