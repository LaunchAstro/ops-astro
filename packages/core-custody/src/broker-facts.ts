// SPDX-License-Identifier: AGPL-3.0-only
//
// The six facts of a model call (AW-01), the task's client link (C60) and
// the task as a bound field's source (S3), read from rows under the
// contract's lock order, and the room already committed out of a reservation.

import { isUuid, slotOf, TASK_SPINE, type TenantQuery } from '../../core-records/src/index.ts';
import { holdsWork } from './broker-holds.ts';
import { LEAVES_ROW_DATA, type TaskSource } from './broker-sources.ts';
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

/** The spine's client slot: the party link `task.set_party` writes. */
const CLIENT_SLOT = slotOf(TASK_SPINE, 'client');

/** The run's task, with what S3 reads of it as a source (`broker-sources.ts`). */
const LOCK_TASK = `select t.id::text as id, run.id::text as run_id, t.${CLIENT_SLOT}::text as client,
            t.deleted_at is null as live, t.data, exists (
              select 1 from public.operations o
                join public.actors a on a.business_id = o.business_id and a.id = o.actor_id
               where o.business_id = t.business_id and o.record_id = t.id
                 and o.outcome = 'applied' and a.kind <> 'person'
                 and o.command <> all($3::text[])) as others_wrote
       from public.leases l
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
       join public.records t on t.business_id = run.business_id and t.id = run.task_id
      where l.business_id = $1 and l.id = $2
      for share of t`;

/**
 * The run's task, first in the lock order (`task` comes before `lease`), held
 * `for share` so a `task.set_party` cannot move its client while the call is
 * decided, and answering the task's client link (C60) and what a bound
 * field reads of it (S3): a link or an edit in flight is waited on, never
 * missed. The lease names the run and the run its
 * task, read here before the lease's own lock; the run's task is fixed once
 * written (the application may update a run's state only, 0043), and the
 * lease's run is compared again under the lease's lock (`lockFacts`).
 * Unknown to this business answers nothing, refused as a made-up lease is.
 */
async function lockTask(
  tx: TenantQuery,
  leaseId: string,
): Promise<
  | { readonly runId: string; readonly clientId: string | null; readonly source: TaskSource }
  | undefined
> {
  const [task] = await tx.query<{
    id: string;
    run_id: string;
    client: string | null;
    live: boolean;
    data: Record<string, unknown>;
    others_wrote: boolean;
  }>(LOCK_TASK, [tx.businessId, leaseId, LEAVES_ROW_DATA]);
  if (task === undefined) return undefined;
  const entered = task.data['source'];
  return {
    runId: task.run_id,
    clientId: task.client,
    source: {
      id: task.id,
      live: task.live,
      entered: typeof entered === 'string' ? entered : null,
      othersWrote: task.others_wrote,
      data: task.data,
    },
  };
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
  const task = await lockTask(tx, request.leaseId);
  if (task === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  await lockRun(tx, task.runId);
  const leased = await lockLease(tx, caller, request);
  if (!leased.ok) return leased;
  const { lease } = leased;
  // The task held is the lease's run's: a lease moved to another run between
  // the two reads is refused, never decided on the other task's client.
  if (lease.run_id !== task.runId) return { ok: false, code: 'LEASE_NOT_OWNED' };
  const delegation = await lockDelegation(tx, lease.delegation_id);
  if (!delegation.ok) return delegation;
  const held = await lockHeld(tx, lease, request.stepId);
  if (!held.ok) return held;
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

/**
 * Settlement's locks, by the call's own rows in the contract's order (lease,
 * delegation, reservation), so the cost settles whoever holds the work now.
 * The answer says whether the work stands for this caller: its lease, at its
 * fence, under its delegation, and still live.
 */
export async function lockCall(
  tx: TenantQuery,
  callId: string,
  caller: ModelCaller,
  fence: number,
): Promise<WorkStands> {
  const [call] = await tx.query<{
    lease_id: string;
    delegation_id: string | null;
    reservation_id: string;
  }>(
    `select lease_id, delegation_id, reservation_id from public.model_calls
      where business_id = $1 and id = $2`,
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
