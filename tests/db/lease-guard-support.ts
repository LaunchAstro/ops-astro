// SPDX-License-Identifier: AGPL-3.0-only
//
// What the lease guard's two suites share (`20261004040200_lease_pickup_path`): a
// statement written straight as the application role in a transaction that
// always rolls back, approved work nobody has picked up, and a person's own
// pickup through the production command entry. Not a suite.

import { randomUUID } from 'node:crypto';
import {
  appliedDetail,
  approve,
  asPerson,
  createTask,
  freshPurpose,
  propose,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

/** Thrown to end a transaction whose write was accepted, so the world keeps no trace of it. */
const ACCEPTED = new Error('accepted, rolled back');

export type Answer =
  | { readonly accepted: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly accepted: false; readonly code: string; readonly message: string };

/** One statement as the application role in `business`, always rolled back. */
export async function asApp(
  s: Schedules,
  business: string,
  text: string,
  parameters: readonly unknown[],
): Promise<Answer> {
  let rows: readonly Record<string, unknown>[] = [];
  try {
    await s.db.admin.transaction(async (execute) => {
      await execute('set local role ops_astro_app');
      await execute(`select set_config('app.business_id', $1, true)`, [business]);
      // Plain rows, so a caller compares values and not the driver's result class.
      rows = (await execute<Record<string, unknown>>(text, parameters)).map((row) =>
        Object.assign({}, row),
      );
      throw ACCEPTED;
    });
  } catch (error) {
    if (error === ACCEPTED) return { accepted: true, rows };
    const failed = error as { code?: unknown };
    return { accepted: false, code: String(failed.code), message: String(error) };
  }
  throw new Error('the transaction neither threw nor rolled back');
}

/** Proposed and approved on a new task, and picked up by nobody: a held, unleased reservation. */
export async function approvedWork(s: Schedules): Promise<Detail> {
  const taskId = await createTask(s, `lease guard ${randomUUID()}`);
  const proposal = await propose(s, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
  return { ...(await approve(s, proposal)), taskId };
}

/** The decider picks the reservation up as themselves, on the person route. */
export async function personPickup(s: Schedules, reservationId: unknown): Promise<Detail> {
  const body = { command: 'task.pickup', operationId: randomUUID(), reservationId };
  return appliedDetail(await asPerson(s, { ...body, leaseSeconds: 600 }), 'person pickup');
}

/** The lease row as the owner reads it. */
export async function leaseRow(s: Schedules, leaseId: unknown): Promise<Record<string, unknown>> {
  const found = await s.db.admin.execute<Record<string, unknown>>(
    `select holder_actor_id, delegation_id, fence::int as fence, state, expires_at
       from public.leases where id = $1`,
    [leaseId],
  );
  return found[0] ?? {};
}
