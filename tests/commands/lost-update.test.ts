// SPDX-License-Identifier: AGPL-3.0-only
//
// Two `task.update` calls presenting the same `expectedRevision`, interleaved
// so that both have read the record before either has committed.
//
// This is the shape an independent review reproduced against the code before
// the fix: `prepareCommand` read the target without locking it, so the second
// transaction compared its `expectedRevision` against the row as it stood
// before the first transaction's uncommitted write. Both comparisons passed,
// both applied — revision 2 and revision 3 — and the second write restored the
// title the first had just replaced. The caller who lost was told `applied`,
// which is the one answer optimistic concurrency exists to prevent.
//
// **Why this forces the race rather than hoping for it.** `tests/commands/
// concurrency.test.ts` says of its own two cases that the interleaving is left
// to the server and a green run is not proof the retry ran. That is honest
// there and would not be good enough here, because the defect only appears in
// one ordering. So the transactions are driven by hand: `withSession` holds a
// transaction open for as long as its callback runs, so the first caller runs
// its command and then waits on a barrier while the second caller starts. The
// second blocks inside `prepareCommand`, on the row lock, and cannot proceed
// until the barrier is released and the first transaction commits.
//
// **The interleaving is observed, not slept through.** An earlier version of
// this file waited 500 ms and hoped the second transaction had got as far as
// the contested read. If it had not — a slow connection, a loaded machine —
// the second caller would start *after* the first committed, be refused
// `VERSION_STALE` by ordinary sequential means, and the case would pass green
// without ever covering the defect it names. So the wait is now a question put
// to the server: `awaitBlockedOnLock` polls `pg_stat_activity` on the owner
// connection until a backend in this database is parked in `wait_event_type =
// 'Lock'`, which is the second transaction sitting inside `prepareCommand`'s
// `select ... for update`. It is bounded, and it throws rather than continuing
// if the state never appears, so a run that could not establish the
// interleaving fails loudly instead of passing quietly.
//
// Against the fixed code the second caller re-reads the committed revision and
// is refused `VERSION_STALE`. Against the unfixed code nothing blocks, the
// second caller reads the stale row, and the assertions below fail on the
// outcome and again on the surviving title — the defect is caught twice.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand, runCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('lost-update: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

/** A promise a test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Waiter {
  readonly event: string | null;
  readonly statement: string;
}

/**
 * Wait, bounded, until a backend in this database is blocked on a lock.
 *
 * This is the synchronisation point the interleaving needs. The first
 * transaction holds the row; the second reaches `for update` in
 * `prepareCommand` and parks. Until that backend appears in `pg_stat_activity`
 * with `wait_event_type = 'Lock'` there is no evidence the second transaction
 * ever reached the contested read, and without that evidence the assertions
 * below are about a sequence, not a race.
 *
 * The owner connection asks, because the two application connections are both
 * inside transactions of their own. Recursion rather than a loop, because the
 * repository's lint forbids awaiting in one.
 */
async function awaitBlockedOnLock(db: FreshDatabase, deadline: number): Promise<Waiter> {
  const rows = await db.admin.execute<{
    readonly wait_event: string | null;
    readonly query: string;
  }>(
    `select wait_event, query
       from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event_type = 'Lock'
      limit 1`,
  );
  const found = rows[0];
  if (found !== undefined) return { event: found.wait_event, statement: found.query };
  if (Date.now() > deadline) {
    throw new Error(
      'the second transaction never blocked on a lock: the contested read was not reached, ' +
        'so this run establishes no interleaving and proves nothing about the defect',
    );
  }
  await delay(25);
  return awaitBlockedOnLock(db, deadline);
}

/** How long the interleaving is given to appear. Generous, and finite. */
const WITHIN = 10_000;

describe.skipIf(serverUrl === undefined)('two writers against one revision', () => {
  let db: FreshDatabase;
  let second: Database;
  let business: string;
  let worker: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    // A second connection, because the first is `max: 1` and two transactions
    // on it would queue in the pool rather than race in the server.
    second = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'lost-update');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'writer');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  const titleOf = async (recordId: string): Promise<string | undefined> => {
    const rows = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly title: string }>(
        `select data ->> 'title' as title from records where business_id = $1 and id = $2`,
        [business, recordId],
      ),
    );
    return rows[0]?.title;
  };

  it('applies the first and refuses the second, keeping the first edit', async () => {
    const made = await executeCommand(db.app, business, worker.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'original' },
    });
    expect(isCommandRefusal(made)).toBe(false);
    const recordId = isCommandRefusal(made) ? '' : (made.recordId ?? '');
    const revision = isCommandRefusal(made) ? 0 : (made.revision ?? 0);
    expect(recordId).not.toBe('');

    const update = (title: string) =>
      ({
        command: 'task.update',
        operationId: randomUUID(),
        recordId,
        expectedRevision: revision,
        fields: { title },
      }) as const;

    const commit = barrier();
    const readTaken = barrier();

    // The first caller: run the command, say so, then hold the transaction
    // open until the second caller is known to be waiting on the lock.
    const first = withSession(db.app, business, worker.presented, async (tx, session) => {
      const outcome = await runCommand(tx, session, 'api', update('first writer'));
      readTaken.release();
      await commit.held;
      return outcome;
    });

    await readTaken.held;

    // The second caller, on its own connection and its own transaction. It
    // presents the revision it read before the first caller started — which is
    // exactly what a second browser tab holds.
    const secondCaller = withSession(second, business, worker.presented, async (tx, session) =>
      runCommand(tx, session, 'api', update('second writer')),
    );

    // The interleaving, established rather than assumed: the second
    // transaction is parked on the row lock, inside the contested read, while
    // the first is still open. Only now is it safe to let the first commit.
    //
    // The statement is asserted, not just the wait. Without the lock the
    // second transaction still blocks eventually — on its own `update`, having
    // already compared its `expectedRevision` against the stale row and
    // decided to apply. Blocking at the write is the defect; blocking at the
    // read is the fix, and the statement text is what tells them apart.
    const waiter = await awaitBlockedOnLock(db, Date.now() + WITHIN).finally(() => {
      // Released whatever happened, so a failed run ends rather than hanging
      // the rest of the file behind a transaction nobody will commit.
      commit.release();
    });
    expect(waiter.statement).toContain('for update');

    const [applied, refusedOutcome] = (await Promise.all([first, secondCaller])) as [
      CommandResult,
      CommandResult,
    ];

    expect(isCommandRefusal(applied) ? applied.code : 'applied').toBe('applied');
    expect(isCommandRefusal(refusedOutcome) && refusedOutcome.code).toBe('VERSION_STALE');
    // The revision it names is the one the winner committed, not the one the
    // loser presented: that is what the caller has to re-read against.
    expect(isCommandRefusal(refusedOutcome) && refusedOutcome.names).toStrictEqual([
      `revision=${revision + 1}`,
    ]);

    // The point of the whole case. The loser's write is not merely late, it is
    // absent: the first writer's edit is what the record holds.
    expect(await titleOf(recordId)).toBe('first writer');
  }, 30_000);

  // The fix is a lock in `prepareCommand`, which every targeted command shares,
  // so it is not a property of `task.update`. This case races two *different*
  // handlers against one revision: if the lock had been put in the update
  // handler rather than in the preparation every handler goes through, this
  // would pass the revision check and apply.
  it('holds the same lock for a different targeted handler', async () => {
    const made = await executeCommand(db.app, business, worker.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'raced across handlers' },
    });
    expect(isCommandRefusal(made)).toBe(false);
    const recordId = isCommandRefusal(made) ? '' : (made.recordId ?? '');
    const revision = isCommandRefusal(made) ? 0 : (made.revision ?? 0);

    const commit = barrier();
    const readTaken = barrier();

    const first = withSession(db.app, business, worker.presented, async (tx, session) => {
      const outcome = await runCommand(tx, session, 'api', {
        command: 'task.update',
        operationId: randomUUID(),
        recordId,
        expectedRevision: revision,
        fields: { title: 'update won' },
      });
      readTaken.release();
      await commit.held;
      return outcome;
    });
    await readTaken.held;

    // A different command, the same record, the same revision the update used.
    const other = withSession(second, business, worker.presented, async (tx, session) =>
      runCommand(tx, session, 'api', {
        command: 'task.start',
        operationId: randomUUID(),
        recordId,
        expectedRevision: revision,
      }),
    );

    // The same established interleaving, across two different handlers.
    const waiter = await awaitBlockedOnLock(db, Date.now() + WITHIN).finally(() => {
      commit.release();
    });
    expect(waiter.statement).toContain('for update');

    const [applied, refusedOutcome] = (await Promise.all([first, other])) as [
      CommandResult,
      CommandResult,
    ];
    expect(isCommandRefusal(applied) ? applied.code : 'applied').toBe('applied');
    expect(isCommandRefusal(refusedOutcome) && refusedOutcome.code).toBe('VERSION_STALE');
    expect(await titleOf(recordId)).toBe('update won');
  }, 30_000);
});
