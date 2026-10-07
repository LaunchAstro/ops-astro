// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's model calls for a run in the cost world (`world.ts`), seeded as
// the database owner, the way MP-14-7a seeds the connector rows: each sits on
// the run's own step, lease, version, reservation and delegation, and names
// its caller's delegation as the broker's reserve does (0104).

import { randomUUID } from 'node:crypto';
import type { FreshDatabase } from '../support/fresh-database.ts';

/** Who made a call and when it started, when not the lease's holder a minute into its run. */
interface Placed {
  /** The caller's delegation (0104): a helper's child; the lease's own when absent. */
  readonly by?: string;
  /** When it started, in place of a minute after the run's first call. */
  readonly at?: Date;
}

/**
 * One model call as the broker leaves it: settled at a price, or its cost not
 * known. A settled call names the model that answered and its units, as the
 * priced settle writes them, or neither.
 */
export type Call = Placed &
  (
    | {
        readonly state: 'settled';
        readonly minor: number;
        readonly model?: string;
        readonly units?: readonly [number, number];
      }
    | { readonly state: 'liability_unknown' }
    /** Released on positive proof that nothing happened: a known zero. */
    | { readonly state: 'released' }
    /** Held and committed, not started yet: the broker's row before it sends (broker.ts). */
    | { readonly state: 'reserved' }
  );

/** Where a seeded call sits: the run's own step, lease, version, reservation and delegation. */
interface CallPlace {
  readonly business: string;
  readonly runId: string;
  readonly stepId: unknown;
  readonly leaseId: unknown;
  readonly versionId: unknown;
  readonly reservationId: unknown;
  readonly delegationId: unknown;
  readonly hoursAgo: number;
  readonly minute: number;
}

/**
 * One model call as the broker leaves it, started `minute` minutes into its
 * run, or at `call.at`; a reserved call has not started.
 */
async function insertCall(db: FreshDatabase, call: Call, at: CallPlace): Promise<void> {
  const settled = call.state === 'settled';
  await db.admin.execute(
    `with t as (select coalesce($18::timestamptz, now() - make_interval(hours => $12::int)
                                  + make_interval(mins => $13::int)) as s)
     insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
        delegation_id, caller_delegation_id, operation_key, route_key, route_reach,
        credential_kind, state, reserved_minor, actual_minor, accepted_at, started_at,
        completed_at, ended_at, model_id, input_units, output_units, unknown_since)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($19::uuid, $8::uuid),
             'model.replay_compose', 'local.test', 'local', 'subscription', $9::text, $10, $11,
             (select s from t) - interval '1 minute',
             case when $9::text <> 'reserved' then (select s from t) end,
             case when $14::boolean then (select s from t) + interval '1 minute' end,
             case when $14::boolean or $17::boolean then (select s from t) + interval '1 minute' end,
             $15, $16, $20,
             case when $9::text = 'liability_unknown' then now() end)`,
    [
      at.business,
      randomUUID(),
      at.runId,
      at.stepId,
      at.leaseId,
      at.versionId,
      at.reservationId,
      at.delegationId,
      call.state,
      // Reserved above what it settled at, so only the settled amount is spend.
      settled ? call.minor + 1_000 : 500,
      settled ? call.minor : null,
      at.hoursAgo,
      at.minute,
      settled,
      settled ? (call.model ?? null) : null,
      settled ? (call.units?.[0] ?? null) : null,
      call.state === 'released',
      call.at ?? null,
      call.by ?? null,
      settled ? (call.units?.[1] ?? null) : null,
    ],
  );
}

/** Each call in order, a minute apart, the first `hoursAgo` hours ago. */
export async function seedRunCalls(
  db: FreshDatabase,
  business: string,
  runId: string,
  picked: Record<string, unknown>,
  calls: readonly Call[],
  hoursAgo: number,
): Promise<void> {
  const [row] = await db.admin.execute<{
    readonly reservation_id: string;
    readonly version_id: string;
    readonly step_id: string;
  }>(
    `select r.id as reservation_id, r.version_id,
            (select s.id from public.planned_steps s
              where s.business_id = r.business_id and s.run_id = r.run_id
              order by s.ordinal limit 1) as step_id
       from public.reservations r
      where r.business_id = $1 and r.run_id = $2
      order by r.lease_id is not distinct from $3::uuid desc, r.created_at limit 1`,
    [business, runId, picked['leaseId']],
  );
  let minute = 0;
  for (const call of calls) {
    minute += 1;
    // eslint-disable-next-line no-await-in-loop -- a handful of rows in order
    await insertCall(db, call, {
      business,
      runId,
      stepId: row?.step_id,
      leaseId: picked['leaseId'],
      versionId: row?.version_id,
      reservationId: row?.reservation_id,
      delegationId: picked['delegationId'],
      hoursAgo,
      minute,
    });
  }
}
