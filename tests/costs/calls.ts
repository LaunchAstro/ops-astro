// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's model calls for a run in the cost world (`world.ts`), seeded as
// the database owner, the way MP-14-7a seeds the connector rows: each sits on
// the run's own step, lease, version, reservation and delegation.

import { randomUUID } from 'node:crypto';
import type { FreshDatabase } from '../support/fresh-database.ts';

/**
 * One model call as the broker leaves it: settled at a price, or its cost not
 * known. A settled call names the model that answered and its units, as the
 * priced settle writes them, or neither.
 */
export type Call =
  | {
      readonly state: 'settled';
      readonly minor: number;
      readonly model?: string;
      readonly units?: readonly [number, number];
    }
  | { readonly state: 'liability_unknown' };

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

/** One model call as the broker leaves it, started `minute` minutes into its run. */
async function insertCall(db: FreshDatabase, call: Call, at: CallPlace): Promise<void> {
  const settled = call.state === 'settled';
  await db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
        delegation_id, operation_key, route_key, route_reach, credential_kind, state,
        reserved_minor, actual_minor, accepted_at, started_at, completed_at, ended_at,
        model_id, input_units, output_units, unknown_since)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'model.replay_compose', 'local.test',
             'local', 'subscription', $9, $10, $11,
             now() - make_interval(hours => $12::int),
             now() - make_interval(hours => $12::int) + make_interval(mins => $13::int),
             case when $14::boolean then now() - make_interval(hours => $12::int)
                    + make_interval(mins => $13::int + 1) end,
             case when $14::boolean then now() - make_interval(hours => $12::int)
                    + make_interval(mins => $13::int + 1) end,
             $15, $16, $17, case when $14::boolean then null else now() end)`,
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
      settled ? Math.max(call.minor, 1) : 500,
      settled ? call.minor : null,
      at.hoursAgo,
      at.minute,
      settled,
      settled ? (call.model ?? null) : null,
      settled ? (call.units?.[0] ?? null) : null,
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
      order by r.created_at limit 1`,
    [business, runId],
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
