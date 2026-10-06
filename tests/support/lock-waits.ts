// SPDX-License-Identifier: AGPL-3.0-only
//
// The pieces a lock-wait race proof is built from: a transaction on its own
// connection that holds what it locked until the test lets it go, and a look
// at `pg_stat_activity` that says a backend is parked on a lock in a named
// statement. A proof orders its steps by what the database reports, never by
// a sleep: the actor is admitted, waits on the lock, the revocation commits,
// and only then is the lock let go.

import { setTimeout as delay } from 'node:timers/promises';
import {
  connect,
  type AdminConnection,
  type BusinessId,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';

/** The kind of lock a backend waits on: a row (`transactionid`) or an advisory key. */
export type LockEvent = 'transactionid' | 'tuple' | 'advisory';

/**
 * Waits until a backend of this database (not the asker's) waits on a lock of
 * this kind in a statement containing `statement`.
 */
export async function waitingOn(
  admin: Pick<AdminConnection, 'execute'>,
  event: LockEvent,
  statement: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await admin.execute<{ waiting: boolean }>(
      `select exists (select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and wait_event = $1
          and strpos(query, $2) > 0) as waiting`,
      [event, statement],
    );
    if (rows[0]?.waiting === true) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`nothing reached a ${event} lock wait in "${statement}"`);
}

const noop = (): void => undefined;

/** A promise the test resolves when it chooses. */
export function gate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = noop;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Thrown inside a held transaction to end it with a rollback. */
class RolledBack extends Error {}

export interface Held {
  /** Ends the holding transaction (commit, or rollback when asked) and closes its connection. */
  letGo(): Promise<void>;
}

/**
 * A fixture transaction on its own connection: `take` runs, and what it locked
 * stays locked until `letGo`. With `rollback`, nothing it wrote survives.
 */
export async function hold(
  url: string,
  businessId: BusinessId | string,
  take: (tx: TenantQuery) => Promise<unknown>,
  ending: 'commit' | 'rollback' = 'commit',
): Promise<Held> {
  const db = connect(url);
  const held = gate();
  const release = gate();
  const done = db
    .withBusiness(businessId as BusinessId, async (tx) => {
      await take(tx);
      held.release();
      await release.promise;
      if (ending === 'rollback') throw new RolledBack('rolled back by the fixture');
    })
    .catch((error: unknown) => {
      if (!(error instanceof RolledBack)) throw error;
    });
  await Promise.race([held.promise, done]);
  return {
    letGo: async () => {
      release.release();
      await done.finally(async () => await db.close());
    },
  };
}
