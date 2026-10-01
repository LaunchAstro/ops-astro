// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10: a broker call as the effect of its run's step. The broker holds a
// call it cannot settle as unknown liability with the drop it was
// (`core-custody/src/broker-fault.ts`) and marks the step as one that may have
// acted, so the runtime's one recovery path stops on it: a hand-back, the
// sweep and the reconciliation pass hold the step unknown and never redo it
// without proof (T3b, T3d1, T3e1). This file is the runtime's half:
//
// - The sweep's: a worker lost mid-call leaves its call started on a lease
//   that ran out. Under the sweep's locks the call is held as `worker_lost`,
//   ours, and its step marked, before the classifier reads the step; a call
//   never started goes back.
// - The pass's: "did it happen?" for a step with held calls is the
//   provider's to answer (the provider phase, `reconcileProviderCalls`). While
//   any of its calls is still unknown there is no answer and the step waits;
//   once every one was proved absent by its provider's declared answer, the
//   step's effect is absent unless the register holds it, or cannot answer
//   because the step's own provider was reached: a call's proof says nothing
//   about that provider. A step whose kind the register cannot answer has no
//   effect but its calls: dispatch refuses any other (`EFFECT_NOT_RECONCILABLE`).
// - A person's: the outcome or write-off they record on the step resolves its
//   held calls with their name, in the same transaction, under the step's locks.
// - The read: each held call's drop, as the task's people read it.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { EffectLookup } from './effect-lookup.ts';

/** The sweep's half, under its locks: the lost worker's started calls held, unsent ones released. */
export async function holdLostCalls(
  tx: TenantQuery,
  reservationIds: readonly string[],
): Promise<void> {
  if (reservationIds.length === 0) return;
  const held = await tx.query<{ readonly reservation_id: string }>(
    `update public.model_calls
        set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_worker_lost',
            drop_cause = 'worker_lost', unknown_since = now()
      where business_id = $1 and reservation_id = any($2::uuid[]) and state = 'dispatched'
      returning reservation_id`,
    [tx.businessId, reservationIds],
  );
  await tx.query(
    `update public.model_calls set state = 'released', ended_at = clock_timestamp()
      where business_id = $1 and reservation_id = any($2::uuid[]) and state = 'reserved'`,
    [tx.businessId, reservationIds],
  );
  await tx.query(
    `update public.attempts
        set dispatch_marker = true
      where business_id = $1 and reservation_id = any($2::uuid[]) and state = 'dispatched'`,
    [tx.businessId, held.map((row) => row.reservation_id)],
  );
}

/**
 * The pass's lookup, with a step's held calls answered first. Their absence
 * proofs speak for the calls only: a step whose own provider was reached (its
 * heartbeat's provider start, or a worker's drop no held call carries) keeps
 * the register's "cannot answer".
 */
export function withProviderCalls(inner: EffectLookup): EffectLookup {
  return async (tx, step) => {
    const calls = await tx.query<{ readonly state: string; readonly drop_cause: string | null }>(
      `select c.state, c.drop_cause from public.model_calls c
         join public.attempts att
           on att.business_id = c.business_id and att.reservation_id = c.reservation_id
        where c.business_id = $1 and att.id = $2 and c.unknown_since is not null`,
      [tx.businessId, step.attemptId],
    );
    if (calls.length === 0) return await inner(tx, step);
    if (!calls.every((call) => call.state === 'released')) return;
    const present = await inner(tx, step);
    if (present !== undefined) return present;
    const [attempt] = await tx.query<{ readonly reached: boolean }>(
      `select provider_started_at is not null
              or (drop_cause in ('provider_unavailable', 'connection_lost')
                  and drop_cause <> all($3::text[])) as reached
         from public.attempts where business_id = $1 and id = $2`,
      [tx.businessId, step.attemptId, calls.map((call) => call.drop_cause ?? '')],
    );
    return attempt?.reached === true ? undefined : false;
  };
}

/**
 * A person's outcome on the step, on its held calls: nothing happened gives
 * the call's hold back; it happened, or happened differently, records the
 * call as the effect at its maximum, since nobody observed less. A write-off
 * leaves the money to the step's own hold and records only the decision.
 */
export async function resolveHeldCalls(
  tx: TenantQuery,
  reservationId: string,
  outcome: 'nothing_happened' | 'happened' | 'happened_differently' | 'written_off',
  personId: string,
): Promise<void> {
  const ends = outcome !== 'written_off';
  await tx.query(
    `update public.model_calls
        set outcome = $3, outcome_person_id = $4,
            state = case when $3 = 'nothing_happened' then 'released'
                         when $5 then 'settled' else state end,
            actual_minor = case when $5 and $3 <> 'nothing_happened' then reserved_minor
                                else actual_minor end,
            ended_at = case when $5 then clock_timestamp() else ended_at end
      where business_id = $1 and reservation_id = $2 and state = 'liability_unknown'
        and outcome is null`,
    [tx.businessId, reservationId, outcome, personId, ends],
  );
}

export interface CallDrop {
  readonly callId: string;
  readonly stepId: string;
  readonly operation: string;
  /** Which drop: provider_unavailable, connection_lost or worker_lost; null for a failure that is none. */
  readonly cause: string | null;
  /** Whose fault: provider, network, ours or undetermined. */
  readonly fault: string | null;
  /** The provider's refusal code, or null when none arrived. */
  readonly providerCode: string | null;
  readonly unknownSince: string;
  readonly reconcileMode: string | null;
  /** How far the call got: held only, or sent to the provider. */
  readonly reached: 'accepted' | 'started';
  /** The run's last event before the call was held: where the work got to. */
  readonly afterEvent: number | null;
  /** What the pass last established. */
  readonly note: string | null;
  readonly outcome: string | null;
}

/** The held calls of `taskId`'s runs, in this business only, oldest first. */
export async function readCallDrops(tx: TenantQuery, taskId: string): Promise<readonly CallDrop[]> {
  return await tx.query<CallDrop>(
    `select c.id as "callId", c.step_id as "stepId", c.operation_key as operation,
            c.drop_cause as cause, c.fault, c.provider_code as "providerCode",
            c.unknown_since::text as "unknownSince", c.reconcile_mode as "reconcileMode",
            case when c.started_at is null then 'accepted' else 'started' end as reached,
            (select max(e.position)::int from public.run_events e
              where e.business_id = c.business_id and e.task_id = run.task_id
                and e.created_at < c.unknown_since) as "afterEvent",
            c.reconcile_note as note, c.outcome
       from public.model_calls c
       join public.planned_runs run on run.business_id = c.business_id and run.id = c.run_id
      where c.business_id = $1 and run.task_id = $2 and c.unknown_since is not null
      order by c.unknown_since, c.id`,
    [tx.businessId, taskId],
  );
}
