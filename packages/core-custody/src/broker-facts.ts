// SPDX-License-Identifier: AGPL-3.0-only
//
// The six facts of a model call (AW-01), the task's client link (C60) and
// the rows its bound fields are read from (S3), read from rows under the
// contract's lock order, and the room already committed out of a reservation.

import {
  isUuid,
  slotOf,
  TASK_SPINE,
  TASK_TYPE_KEY,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import {
  boundRecordIds,
  LEAVES_ROW_DATA,
  sourcesOf,
  type LockedRecord,
  type SourceRow,
} from './broker-sources.ts';
import type { BrokerRefusal, ModelCaller, ModelCallRequest } from './broker-types.ts';

export interface Facts {
  readonly leaseId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly delegationId: string | null;
  readonly workForPersonId: string | null;
  readonly heldMinor: number;
  /** The run's task's client link, or null for a task no client is on (C60). */
  readonly clientId: string | null;
  /** The rows the request's bound fields name, by id, as held (S3). One not here was not readable. */
  readonly sources: ReadonlyMap<string, SourceRow>;
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

/** The run's task and the bound rows, one statement, locked in id order (`lockTask`). */
const LOCK_TASK_AND_SOURCES = `select r.id::text as id, run.id::text as run_id, r.id = run.task_id as is_run_task,
            r.${CLIENT_SLOT}::text as client, r.deleted_at is null as live,
            ty.key = $4 as is_task, r.id = any($3::uuid[]) as bound,
            case when r.id = any($3::uuid[]) then r.data end as data,
            case when r.id = any($3::uuid[]) then exists (
              select 1 from public.operations o
                join public.actors a on a.business_id = o.business_id and a.id = o.actor_id
               where o.business_id = r.business_id and o.record_id = r.id
                 and o.outcome = 'applied' and a.kind <> 'person'
                 and o.command <> all($5::text[])) end as others_wrote
       from public.leases l
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
       join public.records r on r.business_id = run.business_id
                            and (r.id = run.task_id or r.id = any($3::uuid[]))
       join public.record_types ty on ty.business_id = r.business_id and ty.id = r.record_type_id
      where l.business_id = $1 and l.id = $2
      order by r.id
      for share of r`;

/**
 * The run's task, first in the lock order (`task` comes before `lease`), held
 * `for share` so a `task.set_party` cannot move its client while the call is
 * decided, and answering the task's client link (C60). The rows the bound
 * fields name are records too, so they are held in the same statement, in
 * the class's key order (by id), and a link or an edit in flight on one is
 * waited on, never missed (S3). The lease names the run and the run its
 * task, read here before the lease's own lock; the run's task is fixed once
 * written (the application may update a run's state only, 0033), and the
 * lease's run is compared again under the lease's lock (`lockFacts`).
 * Unknown to this business answers nothing, refused as a made-up lease is;
 * a bound row of another business, or none, is simply not among the rows.
 */
async function lockTask(
  tx: TenantQuery,
  leaseId: string,
  boundIds: readonly string[],
): Promise<
  | {
      readonly runId: string;
      readonly clientId: string | null;
      readonly sources: ReadonlyMap<string, SourceRow>;
    }
  | undefined
> {
  const rows = await tx.query<LockedRecord>(LOCK_TASK_AND_SOURCES, [
    tx.businessId,
    leaseId,
    boundIds.filter((id) => isUuid(id)),
    TASK_TYPE_KEY,
    LEAVES_ROW_DATA,
  ]);
  const task = rows.find((row) => row.is_run_task);
  if (task === undefined) return undefined;
  return { runId: task.run_id, clientId: task.client, sources: sourcesOf(rows) };
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
    lease.holder_actor_id !== caller.actorId ||
    lease.delegation_id !== caller.delegationId ||
    lease.fence !== String(request.fence)
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
  request: Pick<ModelCallRequest, 'leaseId' | 'fence' | 'stepId' | 'fields'>,
): Promise<Checked> {
  // A malformed identity or fence is refused like a made-up one, before any row is read.
  if (!isUuid(request.leaseId) || !isUuid(request.stepId) || !Number.isSafeInteger(request.fence)) {
    return { ok: false, code: 'LEASE_NOT_OWNED' };
  }
  const task = await lockTask(tx, request.leaseId, boundRecordIds(request.fields));
  if (task === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
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
      workForPersonId: delegation.personId,
      heldMinor: held.heldMinor,
      clientId: task.clientId,
      sources: task.sources,
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
    lease.holder_actor_id !== caller.actorId ||
    lease.delegation_id !== caller.delegationId ||
    lease.fence !== String(fence)
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
