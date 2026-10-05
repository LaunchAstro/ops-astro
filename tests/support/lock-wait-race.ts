// SPDX-License-Identifier: AGPL-3.0-only
//
// What the expiry-during-a-lock-wait races share. A row is held `for update`
// by a transaction on a connection of its own; the racer is seen waiting on
// that holder in `pg_stat_activity` (`pg_blocking_pids`), never assumed to be
// after a sleep; the racer's transaction is shown to have begun before the
// deadline; and the holder lets go only once the database clock is past it.
// The one sleep is the poll that lets a short expiry pass while the row is held.

import { setTimeout as delay } from 'node:timers/promises';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment, type EmptyDatabase } from './fresh-database.ts';

const noop = (): void => undefined;

export interface Held {
  /** The holding backend, which the racer's wait names as its blocker. */
  readonly pid: number;
  /** Commit the holder, letting the racer through, and close its connection. Idempotent. */
  letGo(): Promise<void>;
}

/** The owner's address of this throwaway database. */
function ownerUrl(db: EmptyDatabase): string {
  const server = databaseUrlFromEnvironment();
  if (server === undefined) throw new Error('lock-wait-race: no database server is configured');
  const url = new URL(server);
  url.pathname = `/${db.name}`;
  return url.toString();
}

/**
 * Runs `statement` (a `select ... for update`) in a transaction on the owner's
 * own connection and keeps it open until `letGo`.
 */
export async function holdRow(
  db: EmptyDatabase,
  statement: string,
  parameters: readonly unknown[],
): Promise<Held> {
  const owner = connectAsAdmin(ownerUrl(db));
  let release: () => void = noop;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding: (pid: number) => void = noop;
  const held = new Promise<number>((resolve) => {
    holding = resolve;
  });
  const done = owner.transaction(async (execute) => {
    const rows = await execute(statement, parameters);
    if (rows.length === 0) throw new Error(`holdRow: no row to hold for ${statement}`);
    const [me] = await execute<{ readonly pid: number }>('select pg_backend_pid() as pid');
    holding(Number(me?.pid));
    await released;
  });
  const pid = await Promise.race([held, done.then(() => -1)]).catch(async (cause: unknown) => {
    await owner.close();
    throw cause;
  });
  if (pid === -1) throw new Error('holdRow: the holder ended before it held its row');
  let gone = false;
  return {
    pid,
    letGo: async () => {
      if (gone) return;
      gone = true;
      release();
      try {
        await done;
      } finally {
        await owner.close();
      }
    },
  };
}

/**
 * Waits until a backend of this database waits on a lock `held` holds, and
 * answers whether that waiter's transaction began before `deadline` (a
 * timestamptz as text, read from the database).
 */
export async function blockedBefore(
  db: EmptyDatabase,
  held: Held,
  deadline: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await db.admin.execute<{ readonly before: boolean | null }>(
      `select bool_and(a.xact_start < $2::timestamptz) as before
         from pg_stat_activity a
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and $1::int = any(pg_blocking_pids(a.pid))`,
      [held.pid, deadline],
    );
    const before = rows[0]?.before;
    if (before !== null && before !== undefined) return before;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error('nothing ever waited on the held row: the schedule was not established');
}

/** Polls the database clock, never the test's, until it is past `deadline`. */
export async function waitPast(db: EmptyDatabase, deadline: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await db.admin.execute<{ readonly past: boolean }>(
      'select clock_timestamp() > $1::timestamptz as past',
      [deadline],
    );
    if (rows[0]?.past === true) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(25);
  }
  throw new Error(`the database clock never passed ${deadline}`);
}

/** One timestamptz, as text so no precision is lost, from `sql` (one row, column `at`). */
export async function instantOf(
  db: EmptyDatabase,
  sql: string,
  parameters: readonly unknown[],
): Promise<string> {
  const rows = await db.admin.execute<{ readonly at: string | null }>(sql, parameters);
  const at = rows[0]?.at;
  if (at === null || at === undefined) throw new Error(`instantOf: no instant from ${sql}`);
  return at;
}
