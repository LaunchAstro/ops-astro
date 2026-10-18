// SPDX-License-Identifier: AGPL-3.0-only
//
// The six facts of a model call (AW-01), the task's client link (C60) and
// the task as a bound field's source (S3, `broker-task.ts`), read from rows
// under the contract's lock order, and the room already committed out of a
// reservation.

import { isUuid, type TenantQuery } from '../../core-records/src/index.ts';
import { holdsWork } from './broker-holds.ts';
import type { TaskSource } from './broker-sources.ts';
import { readTask, shareTask } from './broker-task.ts';
import type { BrokerRefusal, ModelCaller, ModelCallRequest } from './broker-types.ts';

export interface Facts {
  readonly leaseId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly delegationId: string | null;
  /** The caller's own delegation: the lease's for its holder, a child's for a helper (AW-11). */
  readonly callerDelegationId: string | null;
  readonly workForPersonId: string | null;
  readonly heldMinor: number;
  /** The run's task's client link, or null for a task no client is on (C60). */
  readonly clientId: string | null;
  /** The run's task as a bound field's source, as held (S3). */
  readonly source: TaskSource;
}

export type Checked =
  | { readonly ok: true; readonly facts: Facts }
  | { readonly ok: false; readonly code: BrokerRefusal };

type Refused = { readonly ok: false; readonly code: BrokerRefusal };

interface LeaseRow {
  readonly run_id: string;
  readonly reservation_id: string;
  readonly delegation_id: string | null;
  readonly holder_actor_id: string;
  readonly fence: string;
  readonly live: boolean;
}

/**
 * The run, after its task and before its lease (the contract's order): a call
 * that reaches the ceiling moves it into the budget wait (AW-05,
 * `broker-wait.ts`), so two calls on one run stop it once.
 */
async function lockRun(tx: TenantQuery, runId: string): Promise<void> {
  await tx.query(
    `select 1 from public.planned_runs where business_id = $1 and id = $2 for update`,
    [tx.businessId, runId],
  );
}

/** The lease, next in the lock order. Another business's, a made-up one, someone else's and one of our own under another delegation all read alike. */
async function lockLease(
  tx: TenantQuery,
  caller: ModelCaller,
  request: Pick<ModelCallRequest, 'leaseId' | 'fence'>,
): Promise<{ readonly ok: true; readonly lease: LeaseRow } | Refused> {
  const [lease] = await tx.query<LeaseRow>(
    `select run_id, reservation_id, delegation_id, holder_actor_id, fence::text as fence,
            (state = 'live' and expires_at > clock_timestamp()) as live
       from public.leases where business_id = $1 and id = $2 for update`,
    [tx.businessId, request.leaseId],
  );
  if (
    lease === undefined ||
    lease.fence !== String(request.fence) ||
    !(await holdsWork(tx, caller, lease))
  ) {
    return { ok: false, code: 'LEASE_NOT_OWNED' };
  }
  if (!lease.live) return { ok: false, code: 'LEASE_EXPIRED' };
  return { ok: true, lease };
}

/** The delegation, after the lease: the person the work is for, or none for a person's own lease. */
async function lockDelegation(
  tx: TenantQuery,
  delegationId: string | null,
): Promise<{ readonly ok: true; readonly personId: string | null } | Refused> {
  if (delegationId === null) return { ok: true, personId: null };
  const [delegation] = await tx.query<{ delegate_person_id: string; live: boolean }>(
    `select delegate_person_id,
            (revoked_at is null and settled_at is null and expires_at > clock_timestamp()) as live
       from public.delegations where business_id = $1 and id = $2 for update`,
    [tx.businessId, delegationId],
  );
  if (delegation === undefined) return { ok: false, code: 'AUTHORITY_LOST' };
  if (!delegation.live) return { ok: false, code: 'AUTHORITY_LOST' };
  return { ok: true, personId: delegation.delegate_person_id };
}

/** The reservation, last, for the run's approved version, and the step, which must be the run's. */
async function lockHeld(
  tx: TenantQuery,
  lease: LeaseRow,
  stepId: string,
): Promise<
  | {
      readonly ok: true;
      readonly versionId: string;
      readonly heldMinor: number;
      readonly stepId: string;
    }
  | Refused
> {
  const [held] = await tx.query<{ version_id: string; held_minor: string; state: string }>(
    `select r.version_id, r.held_minor::text as held_minor, r.state
       from public.reservations r
       join public.planned_runs run
         on run.business_id = r.business_id and run.id = r.run_id and run.version_id = r.version_id
      where r.business_id = $1 and r.id = $2 and r.run_id = $3
      for update of r`,
    [tx.businessId, lease.reservation_id, lease.run_id],
  );
  if (held === undefined || held.state !== 'held') {
    return { ok: false, code: 'DECISION_STALE' };
  }
  const [step] = await tx.query<{ id: string }>(
    `select id from public.planned_steps where business_id = $1 and id = $2 and run_id = $3`,
    [tx.businessId, stepId, lease.run_id],
  );
  if (step === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  return {
    ok: true,
    versionId: held.version_id,
    heldMinor: Number(held.held_minor),
    stepId: step.id,
  };
}

/**
 * The six facts and the client link, read under the contract's lock order
 * (task, lease, delegation, reservation). Settlement takes the same locks by
 * the call's own rows instead (`lockCall`), less the task: what it settles was
 * already sent.
 */
export async function lockFacts(
  tx: TenantQuery,
  caller: ModelCaller,
  request: Pick<ModelCallRequest, 'leaseId' | 'fence' | 'stepId'>,
): Promise<Checked> {
  // A malformed identity or fence is refused like a made-up one, before any row is read.
  if (!isUuid(request.leaseId) || !isUuid(request.stepId) || !Number.isSafeInteger(request.fence)) {
    return { ok: false, code: 'LEASE_NOT_OWNED' };
  }
  const runId = await shareTask(tx, request.leaseId);
  if (runId === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  await lockRun(tx, runId);
  const leased = await lockLease(tx, caller, request);
  if (!leased.ok) return leased;
  const { lease } = leased;
  // The task held is the lease's run's: a lease moved to another run between
  // the two reads is refused, never decided on the other task's client.
  if (lease.run_id !== runId) return { ok: false, code: 'LEASE_NOT_OWNED' };
  const delegation = await lockDelegation(tx, lease.delegation_id);
  if (!delegation.ok) return delegation;
  const held = await lockHeld(tx, lease, request.stepId);
  if (!held.ok) return held;
  // Source and party after the last wait (R6): the task row is held, its register is not.
  const task = await readTask(tx, request.leaseId);
  if (task === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  return {
    ok: true,
    facts: {
      leaseId: request.leaseId,
      runId: lease.run_id,
      stepId: held.stepId,
      versionId: held.versionId,
      reservationId: lease.reservation_id,
      delegationId: lease.delegation_id,
      callerDelegationId: caller.delegationId,
      workForPersonId: delegation.personId,
      heldMinor: held.heldMinor,
      clientId: task.clientId,
      source: task.source,
    },
  };
}

/** Whether a settled call's work still stands for its caller. */
export type WorkStands = 'stands' | 'LEASE_EXPIRED' | 'LEASE_NOT_OWNED';

type CallRows = { lease_id: string; delegation_id: string | null; reservation_id: string };

/**
 * Settlement's locks, by the call's own rows in the contract's order (envelope,
 * lease, delegation, reservation): the cost settles whoever holds the work now,
 * and a call counted at its maximum gives back what it did not spend (`giveBack`).
 * The answer: whether the work stands for this caller (lease, fence, delegation, live).
 */
export async function lockCall(
  tx: TenantQuery,
  callId: string,
  caller: ModelCaller,
  fence: number,
): Promise<WorkStands> {
  const [call] = await tx.query<CallRows>(
    `select c.lease_id, c.delegation_id, c.reservation_id from public.model_calls c
       join public.reservations r on r.business_id = c.business_id and r.id = c.reservation_id
       join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
      where c.business_id = $1 and c.id = $2 for update of e`,
    [tx.businessId, callId],
  );
  if (call === undefined) throw new Error(`model call ${callId}: no row to settle`);
  const [lease] = await tx.query<Omit<LeaseRow, 'run_id' | 'reservation_id'>>(
    `select delegation_id, holder_actor_id, fence::text as fence,
            (state = 'live' and expires_at > clock_timestamp()) as live
       from public.leases where business_id = $1 and id = $2 for update`,
    [tx.businessId, call.lease_id],
  );
  if (call.delegation_id !== null) {
    await tx.query(
      `select 1 from public.delegations where business_id = $1 and id = $2 for update`,
      [tx.businessId, call.delegation_id],
    );
  }
  await tx.query(
    `select 1 from public.reservations where business_id = $1 and id = $2 for update`,
    [tx.businessId, call.reservation_id],
  );
  if (
    lease === undefined ||
    lease.fence !== String(fence) ||
    !(await holdsWork(tx, caller, lease))
  ) {
    return 'LEASE_NOT_OWNED';
  }
  return lease.live ? 'stands' : 'LEASE_EXPIRED';
}

/** What the run's calls already hold or spent out of its reservation. */
export async function committedMinor(tx: TenantQuery, reservationId: string): Promise<number> {
  const [row] = await tx.query<{ committed: string }>(
    `select coalesce(sum(case when state = 'settled' then actual_minor
                              when state in ('reserved', 'dispatched', 'liability_unknown') then reserved_minor
                              else 0 end), 0)::text as committed
       from public.model_calls where business_id = $1 and reservation_id = $2`,
    [tx.businessId, reservationId],
  );
  return Number(row?.committed ?? 0);
}
