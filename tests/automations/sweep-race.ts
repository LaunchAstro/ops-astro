// SPDX-License-Identifier: AGPL-3.0-only
//
// What the occurrence sweep's race, crash and retry proofs share. An
// activation's lock is held by a transaction on a connection of its own, so a
// pass on another connection is seen waiting on it (`waitingOn`), never
// assumed to after a sleep. A pass is crashed by a database handle whose one
// transaction aborts at one step, so what the pass wrote before the crash is
// read back from the database, not its report.

import {
  connect,
  lockActivation,
  type ActivationRow,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { latch } from '../support/lock-wait-race.ts';
import type { AutomationWorld } from './world.ts';

export interface HeldActivation {
  /** Commit the holder, letting a waiting pass through, and close its connection. */
  letGo(): Promise<void>;
}

/**
 * The activation's lock, taken in the first business's transaction on a
 * connection of its own; `during` runs in that transaction with the locked
 * row, and what it writes commits at `letGo`.
 */
export async function holdActivation(
  w: AutomationWorld,
  activationId: string,
  during?: (tx: TenantQuery, row: ActivationRow) => Promise<void>,
): Promise<HeldActivation> {
  const own = connect(w.db.appUrl);
  const held = latch();
  const released = latch();
  const done = own.withBusiness(w.alpha, async (tx) => {
    const row = await lockActivation(tx, activationId);
    if (row === null) throw new Error('holdActivation: no activation to hold');
    await during?.(tx, row);
    held.open();
    await released.promise;
  });
  await Promise.race([held.promise, done]);
  let gone = false;
  return {
    letGo: async () => {
      if (gone) return;
      gone = true;
      released.open();
      try {
        await done;
      } finally {
        await own.close();
      }
    },
  };
}

/** Where in its transaction a crashed pass dies. */
export type CrashStep = 'before-work' | 'before-commit';

/**
 * `inner`, except that its `nth` transaction (from 1) aborts at `step`: before
 * its work runs (the read before it done, nothing of its own written), or
 * after its work and before the commit, as a process lost mid-transaction
 * leaves it: the database rolls back what was not committed.
 */
export function crashingAt(inner: Database, nth: number, step: CrashStep): Database {
  let transactions = 0;
  return {
    log: inner.log,
    close: async () => await inner.close(),
    withBusiness: async (business, work) =>
      await inner.withBusiness(business, async (tx) => {
        transactions += 1;
        if (transactions !== nth) return await work(tx);
        if (step === 'before-work') throw new Error('the pass died before its write');
        await work(tx);
        throw new Error('the pass died after its write, before the commit');
      }),
  };
}

/** Each occurrence of the activation: its due time, outcome, and whether a run started. */
export async function firedOf(
  w: AutomationWorld,
  activationId: string,
): Promise<{ due: string | null; outcome: string; started: boolean }[]> {
  const rows = await w.db.admin.execute<{
    due: Date | null;
    outcome: string;
    run: string | null;
  }>(
    `select o.due_at as due, o.outcome, d.run_id as run
       from public.activation_occurrences o
       left join public.occurrence_dispatches d
         on d.business_id = o.business_id and d.occurrence_id = o.id
      where o.activation_id = $1 order by o.due_at, o.recorded_at`,
    [activationId],
  );
  return rows.map((row) => ({
    due: row.due === null ? null : new Date(row.due).toISOString(),
    outcome: row.outcome,
    started: row.run !== null,
  }));
}

/** Runs started for the activation's occurrences, counted in the database. */
export async function runsOf(w: AutomationWorld, activationId: string): Promise<number> {
  return await w.count(
    `select count(*) as n from public.planned_runs r
       join public.activation_occurrences o
         on o.business_id = r.business_id and o.id = r.origin_occurrence_id
      where o.activation_id = $1`,
    [activationId],
  );
}
