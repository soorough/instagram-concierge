import Database from 'better-sqlite3';
import { describe, expect, it, afterEach } from 'vitest';
import { migrate, resetAll, type DB } from '../src/store/db.ts';
import { resetDisabledReason } from '../src/console/simulate.ts';

/**
 * Clearing the console between demo runs.
 *
 * The interesting table is `opener_decision`. A comment grants exactly one
 * Private Reply — permanently, not per session or per deploy — and that record
 * is the only thing standing between a redeploy and a second DM to someone who
 * commented once. Wiping it is safe when replies are recorded, and unrecoverable
 * when they are sent, so the guard matters more than the truncation does.
 */
const fresh = (): DB => {
  const db = new Database(':memory:') as unknown as DB;
  migrate(db);
  return db;
};

const before = process.env.DISPATCH;
afterEach(() => {
  if (before === undefined) delete process.env.DISPATCH;
  else process.env.DISPATCH = before;
});

describe('reset', () => {
  it('empties every table the console reads, not just the visible ones', () => {
    const db = fresh();
    db.prepare('insert into processed_event values (?,?,?)').run('e1', 'message', 1);
    db.prepare('insert into conversation values (?,?,?,?,?)').run('c1', 'slittone', 1, 1, null);
    db.prepare('insert into message (customer_id, role, text, at) values (?,?,?,?)')
      .run('c1', 'customer', 'hi', 1);
    db.prepare('insert into opener_decision values (?,?,?,?,?)')
      .run('cm1', 'c1', 'withhold', 'no substance', 1);
    db.prepare(
      'insert into turn (customer_id,event_id,kind,model_calls,model_ms,tool_ms,escalated,reply,at) values (?,?,?,?,?,?,?,?,?)',
    ).run('c1', 'e1', 'message', 1, 10, 0, 0, 'hello', 1);
    db.prepare(
      'insert into tool_call (turn_id,customer_id,tool,arguments,ok,duration_ms,at) values (?,?,?,?,?,?,?)',
    ).run(1, 'c1', 'search_catalog', '{}', 1, 5, 1);

    resetAll(db);

    for (const table of ['processed_event', 'conversation', 'message', 'opener_decision', 'turn', 'tool_call']) {
      const { n } = db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
      expect(n, `${table} should be empty`).toBe(0);
    }
  });

  it('lets an event id be processed again once history is cleared', () => {
    const db = fresh();
    db.prepare('insert into processed_event values (?,?,?)').run('e1', 'message', 1);
    resetAll(db);
    // A demo that could not replay the same fixture twice would be useless.
    expect(() => db.prepare('insert into processed_event values (?,?,?)').run('e1', 'message', 2))
      .not.toThrow();
  });

  it('is refused while the dispatcher is live', () => {
    process.env.DISPATCH = 'live';
    // Clearing opener_decision against a live dispatcher hands back a fresh
    // allowance for Openers that were already spent. There is no undo.
    expect(resetDisabledReason()).toMatch(/live/);
  });

  it('is allowed when replies are only recorded', () => {
    delete process.env.DISPATCH;
    expect(resetDisabledReason()).toBeUndefined();
  });
});
