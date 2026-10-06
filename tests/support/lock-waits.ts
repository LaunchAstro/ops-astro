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

/**
 * After a revocation is sent while a writer waits on a row lock in
 * `statement`: waits until the revocation has answered (`answered`), or until
 * `pg_blocking_pids` names that writer's backend as what the revocation waits
 * on. Taken on what the database shows, never on a poll running out.
 */
export async function revokedOrBehindWriter(
  admin: Pick<AdminConnection, 'execute'>,
  statement: string,
  answered: () => boolean,
): Promise<'revoked' | 'behind the writer'> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (answered()) return 'revoked';
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await admin.execute<{ behind: boolean }>(
      `select exists (select 1 from pg_stat_activity w, pg_stat_activity r
        where w.datname = current_database() and r.datname = current_database()
          and w.wait_event_type = 'Lock' and w.wait_event = 'transactionid'
          and strpos(w.query, $1) > 0 and r.pid <> w.pid
          and w.pid = any(pg_blocking_pids(r.pid))) as behind`,
      [statement],
    );
    if (rows[0]?.behind === true) return 'behind the writer';
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`the revocation neither answered nor waited behind the writer in "${statement}"`);
}

/**
 * After a revocation is sent while a command sits paused, idle in its
 * transaction, straight after a statement containing `statement`: waits until
 * the revocation has answered, or until `pg_blocking_pids` names that paused
 * backend as what the revocation's advisory lock waits on.
 */
export async function revokedOrBehindHolder(
  admin: Pick<AdminConnection, 'execute'>,
  statement: string,
  answered: () => boolean,
): Promise<'revoked' | 'behind the holder'> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (answered()) return 'revoked';
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await admin.execute<{ behind: boolean }>(
      `select exists (select 1 from pg_stat_activity h, pg_stat_activity r
        where h.datname = current_database() and r.datname = current_database()
          and h.state = 'idle in transaction' and strpos(h.query, $1) > 0
          and r.wait_event_type = 'Lock' and r.wait_event = 'advisory'
          and h.pid = any(pg_blocking_pids(r.pid))) as behind`,
      [statement],
    );
    if (rows[0]?.behind === true) return 'behind the holder';
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`the revocation neither answered nor waited behind the holder of "${statement}"`);
}

/**
 * Where each operation's audit event stands in its business's chain. `seq` is
 * given under a transaction-scoped advisory lock (migration 0093), so the
 * order of two places is the order their transactions committed in.
 */
export async function chainPlaces(
  admin: Pick<AdminConnection, 'execute'>,
  operationIds: readonly string[],
): Promise<readonly number[]> {
  const rows = await admin.execute<{ operation_id: string; seq: number }>(
    'select operation_id::text, seq::int as seq from public.audit_events where operation_id = any($1::text[])',
    [operationIds],
  );
  return operationIds.map((id) => {
    const found = rows.filter((row) => row.operation_id === id);
    if (found.length !== 1) throw new Error(`chainPlaces: ${found.length} audit events for ${id}`);
    return Number(found[0]?.seq);
  });
}
