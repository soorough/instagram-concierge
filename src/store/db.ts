import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';

export type DB = Database.Database;

let shared: DB | null = null;

/**
 * Schema.
 *
 * `processed_event` is the idempotency ledger and the reason this module exists
 * at all. Meta redelivers, so the primary key is what makes a duplicate cheap to
 * detect: claiming is an INSERT that either succeeds once or fails forever.
 *
 * Note it keys on the *Event*, not the Delivery. One Delivery can carry several
 * Events, so keying on the request would drop real work under batching.
 *
 * `opener_decision` records the Withheld Opener as a first-class outcome. A
 * comment grants exactly one Private Reply, permanently, so the decision is
 * written before the send is attempted — a crash after sending but before
 * recording would burn the one message we get and leave no trace of it.
 */
const SCHEMA = `
  create table if not exists processed_event (
    event_id    text primary key,
    kind        text not null,
    received_at integer not null
  );

  create table if not exists conversation (
    customer_id  text primary key,
    username     text,
    created_at   integer not null,
    -- When the Customer last wrote. The 24-hour Reply Window is measured from
    -- here, so it must record *their* messages, never ours.
    last_seen_at integer not null,
    -- The Cart survives between Turns. Without this, "add one more" starts a
    -- second cart and the Customer is handed a checkout link missing everything
    -- they chose earlier.
    cart_id      text
  );

  create table if not exists message (
    id          integer primary key autoincrement,
    customer_id text not null references conversation(customer_id),
    role        text not null check (role in ('customer', 'concierge')),
    text        text not null,
    at          integer not null
  );
  create index if not exists message_by_customer on message (customer_id, at);

  create table if not exists opener_decision (
    comment_id  text primary key,
    customer_id text not null,
    decision    text not null check (decision in ('send', 'withhold')),
    reason      text not null,
    at          integer not null
  );

  -- A Turn is one inbound Event and the reply it produced. Giving it a row is
  -- what lets the console attribute Tool calls to the reply they caused, rather
  -- than guessing from timestamps.
  create table if not exists turn (
    id          integer primary key autoincrement,
    customer_id text not null,
    event_id    text not null,
    kind        text not null,
    model_calls integer not null,
    model_ms    integer not null,
    tool_ms     integer not null,
    escalated   integer not null,
    reply       text not null,
    at          integer not null
  );
  create index if not exists turn_by_customer on turn (customer_id, at);

  create table if not exists tool_call (
    id          integer primary key autoincrement,
    turn_id     integer references turn(id),
    customer_id text not null,
    tool        text not null,
    arguments   text not null,
    ok          integer not null,
    result      text,
    duration_ms integer not null,
    at          integer not null
  );
  create index if not exists tool_call_by_customer on tool_call (customer_id, at);
  create index if not exists tool_call_by_turn on tool_call (turn_id);
`;

export function migrate(db: DB): void {
  db.exec(SCHEMA);

  /**
   * Columns added after the first release.
   *
   * `create table if not exists` does nothing to a table that already exists,
   * so a database created before this column simply would not have it — and the
   * failure lands at query time, on a deployed instance, rather than at boot.
   * Adding it here keeps an existing volume working across a redeploy.
   */
  const columns = (db.prepare('pragma table_info(conversation)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes('request_state')) {
    db.exec(
      `alter table conversation add column request_state text not null default 'none'`,
    );
  }
}

function openDb(path?: string): DB {
  const resolved = resolve(path ?? config.dbPath());
  if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true });

  const db = new Database(resolved);
  // WAL keeps the Receiver's write of an idempotency claim from blocking behind
  // a Turn that is still reading Conversation history.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function getDb(): DB {
  shared ??= openDb();
  return shared;
}

/**
 * Empties every table, so a demo can be run again from nothing.
 *
 * Order follows the foreign keys — `message` and `tool_call` reference rows in
 * `conversation` and `turn` — and the whole thing is one transaction, because a
 * half-cleared database is worse than either state: `turn` rows whose
 * `tool_call` children survived would render as replies that made tool calls
 * they never made.
 *
 * `processed_event` goes too, which is the point rather than an oversight: it
 * holds the idempotency claims, and leaving them would mean the same Fixture
 * could never be replayed a second time.
 *
 * Callers must check `resetDisabledReason()` first. This function does not
 * consult the dispatcher — it is the truncation, not the policy — and clearing
 * `opener_decision` against a live dispatcher hands back Openers that were
 * already spent, which no demo is worth.
 */
export function resetAll(db: DB): void {
  db.transaction(() => {
    for (const table of [
      'tool_call',
      'turn',
      'message',
      'opener_decision',
      'conversation',
      'processed_event',
    ]) {
      db.prepare(`delete from ${table}`).run();
    }
    // Restart autoincrement, so a fresh demo starts at id 1 rather than 200.
    db.prepare("delete from sqlite_sequence where name in ('message','turn','tool_call')").run();
  })();
}
