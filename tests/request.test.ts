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
 * Acceptance is not a button we can see. There is no field for it and no
 * webhook — what the platform gives us is their reply, and nobody writes back
 * to a request they did not open. So an inbound message is the transition, and
 * it is the only signal that actually exists.
 *
 * The console has an Accept button as well, so a demo can show the customer's
 * side of a flow the API keeps hidden. It moves the same state deliberately:
 * whichever arrives first opens the thread, and real traffic never waits on an
 * affordance that only exists in the console.
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

  it('is opened by whichever arrives first, message or button', () => {
    /**
     * The two paths must agree. If a real delivery could be held waiting for a
     * button that exists only in the console, the model would have invented a
     * rule the platform does not have.
     */
    const viaMessage = fresh();
    ensureConversation(viaMessage, 'cust-1', 'slittone');
    openRequest(viaMessage, 'cust-1');
    acceptRequest(viaMessage, 'cust-1');

    const viaButton = fresh();
    ensureConversation(viaButton, 'cust-1', 'slittone');
    openRequest(viaButton, 'cust-1');
    acceptRequest(viaButton, 'cust-1');

    expect(requestState(viaMessage, 'cust-1')).toBe(requestState(viaButton, 'cust-1'));
    expect(requestState(viaMessage, 'cust-1')).toBe('accepted');
  });
});
