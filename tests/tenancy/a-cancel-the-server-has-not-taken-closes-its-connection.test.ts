// SPDX-License-Identifier: AGPL-3.0-only
//
// #2240 (Sol's S2243-3 and S2243-4). The driver's cancel request for the
// statement running at a transaction's deadline travels on a connection of
// its own, and the server applies it to whatever the session runs when it
// lands. One the server has not taken within the driver's wait could land on
// the next transaction on the pooled session, so that connection is closed
// from the client side and the pool goes on with a fresh one. One that never
// lands holds nothing past the deadline either: the server limits each
// statement to the time left when it starts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import { cancelRelay, uncaughtDuring } from '../support/cancel-relay.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';

const BUSINESS = randomUUID();
/** The request bound the hosted pass is held to: its 2,000 ms deadline and #1411's tolerance. */
const BOUND_MS = 3_000;
let db: FreshDatabase;

/** The outcome of a transaction: `committed`, or why it failed. */
async function outcomeOf(transaction: Promise<unknown>): Promise<string> {
  return await transaction.then(
    () => 'committed',
    (cause: unknown) => (cause instanceof Error ? cause.message : 'unknown'),
  );
}

async function sessionOf(database: Database): Promise<number | undefined> {
  const [row] = await database.withBusiness(
    BUSINESS,
    async (tx) => await tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
  );
  return row?.pid;
}

/** Sol's S2243-3 proof: a cancel held past the driver's wait, then a transaction with no deadline. */
async function lateCancel(): Promise<void> {
  const relay = await cancelRelay(db.appUrl, 'late');
  const database = connect(relay.url);
  try {
    const raised = await uncaughtDuring(async () => {
      const first = await sessionOf(database);
      const late = await outcomeOf(
        database.withBusiness(
          BUSINESS,
          async (tx) => {
            await tx.query('select pg_sleep(0.25)');
          },
          { deadline: Date.now() + 200 },
        ),
      );
      expect(late, 'a transaction past its deadline').not.toBe('committed');
      expect(relay.cancels()).toBe(1);
      // The held cancel reaches the server while this transaction runs.
      const [next] = await database.withBusiness(
        BUSINESS,
        async (tx) =>
          await tx.query<{ pid: number }>('select pg_backend_pid() as pid, pg_sleep(1)'),
      );
      expect(relay.delivered(), 'the late cancel reached the server').toBe(1);
      expect(next?.pid, 'the pool goes on with a fresh session').not.toBe(first);
    });
    expect(raised, 'closing the connection raised something nothing caught').toEqual([]);
  } finally {
    await database.close();
    await relay.end();
  }
}

/** Sol's direct S2243-4 proof: a 1,700 ms statement, then a stalled one, under 2,000 ms, the cancel lost. */
async function lostCancel(): Promise<void> {
  const relay = await cancelRelay(db.appUrl, 'lost');
  const database = connect(relay.url);
  try {
    await sessionOf(database);
    const began = performance.now();
    const lost = await outcomeOf(
      database.withBusiness(
        BUSINESS,
        async (tx) => {
          await tx.query('select pg_sleep(1.7)');
          await tx.query('select pg_sleep(5)');
        },
        { deadline: Date.now() + 2_000 },
      ),
    );
    const elapsed = performance.now() - began;
    console.log('lost cancel:', lost, Math.round(elapsed), 'ms');
    expect(relay.cancels()).toBe(1);
    expect(lost).not.toBe('committed');
    expect(elapsed, 'the late statement held the transaction past the bound').toBeLessThan(
      BOUND_MS,
    );
    expect(await sessionOf(database), 'the pool still serves').toBeDefined();
  } finally {
    await database.close();
    await relay.end();
  }
}

/** The server's limits as a second statement sees them, 1 s into a 2 s deadline. */
async function limitsAfterOneSecond(): Promise<void> {
  const database = connect(db.appUrl);
  try {
    const [limits] = await database.withBusiness(
      BUSINESS,
      async (tx) => {
        await tx.query('select pg_sleep(1)');
        return await tx.query<{ statement: number; lock: number }>(
          `select (select setting::int from pg_settings where name = 'statement_timeout') as statement,
                  (select setting::int from pg_settings where name = 'lock_timeout') as lock`,
        );
      },
      { deadline: Date.now() + 2_000 },
    );
    // About 1,000 ms are left after the first statement, plus the 250 ms
    // margin; a limit set once for the transaction would still be 2,250.
    expect(limits?.statement).toBeGreaterThan(0);
    expect(limits?.statement).toBeLessThanOrEqual(1_250);
    expect(limits?.lock).toBeGreaterThan(0);
    expect(limits?.lock).toBeLessThanOrEqual(1_250);
  } finally {
    await database.close();
  }
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a cancel request the server has not taken in time',
  () => {
    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'cancelnottaken' });
    }, 60_000);
    afterAll(async () => {
      await db.drop();
    });

    it(
      'Sol proof, criterion 4: a late cancel cannot cancel the next transaction on the pooled session',
      lateCancel,
      15_000,
    );
    it(
      'Sol proof, criterion 2: a lost cancel still bounds a late-starting statement to the shared deadline',
      lostCancel,
      15_000,
    );
    it(
      "the server's limits on each statement are the time left when it starts, and a margin",
      limitsAfterOneSecond,
    );
  },
);
