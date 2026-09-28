// SPDX-License-Identifier: AGPL-3.0-only
//
// Who owns a lease, asked one way.
//
// Pickup, heartbeat and handback each decide, under their locks, whether the
// caller holds the lease it names, at the fence it presents, with authority
// that is still live. The reading of the lease row, the holder and fence
// rungs, the person's current write and the next fence are here, once, so the
// three cannot drift into three answers to one question.
//
// **One wording rule.** A lease refusal's reason is fixed text chosen by its
// cause and nothing else. It names no lease, fence, task, version or state
// from the store, so it echoes nothing the caller did not send, and a
// foreign, a fabricated and a same-business lease answer in the same bytes
// (root ruling 2). The next step is the operation's own fixed text. Heartbeat
// and handback give the same reason for the same cause.

import type { Subject, TenantQuery } from '../../core-records/src/index.ts';
import type { RuntimeRefusalCode } from '../../core-records/src/index.ts';
import { checkAuthorityAt } from './recovery.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

export type LeaseCause =
  | 'not_owned'
  | 'fence_presented'
  | 'fence_superseded'
  | 'not_live'
  | 'expired'
  | 'version_superseded'
  | 'lineage_ended'
  | 'authority_lost'
  | 'held';

const REASONS: Readonly<Record<LeaseCause, { code: RuntimeRefusalCode; reason: string }>> = {
  not_owned: { code: 'LEASE_NOT_OWNED', reason: "the named lease is not this caller's" },
  fence_presented: {
    code: 'LEASE_NOT_OWNED',
    reason: 'the presented fence is not the fence this lease holds',
  },
  fence_superseded: {
    code: 'LEASE_NOT_OWNED',
    reason: 'the presented fence has been superseded on this task',
  },
  not_live: { code: 'LEASE_EXPIRED', reason: 'the named lease is no longer live' },
  expired: { code: 'LEASE_EXPIRED', reason: 'the named lease expired before this call' },
  version_superseded: {
    code: 'LEASE_NOT_OWNED',
    reason: 'the version this lease worked has been superseded, so its work cannot settle',
  },
  lineage_ended: {
    code: 'LEASE_NOT_OWNED',
    reason: 'the lineage this lease worked is no longer live, so its work cannot settle',
  },
  authority_lost: {
    code: 'SCOPE_NOT_GRANTED',
    reason: 'no live grant of yours covers work on this task any more',
  },
  held: { code: 'LEASE_HELD', reason: 'another live lease owns the work on this task' },
};

/** The fixed reason for a cause, for a caller that spells the code itself. */
export function leaseReason(cause: LeaseCause): string {
  return REASONS[cause].reason;
}

/**
 * The next step when the named lease is not the caller's, per operation. The
 * command layer answers a malformed lease id in these same bytes, before it
 * reaches a uuid parameter (`core-commands/src/commands/tasks-lease.ts`).
 */
export const NOT_OWNED_FIX = {
  handback: 'Hand back the lease your own pickup was issued.',
  heartbeat: 'Renew the lease this pickup issued, at the fence it handed back.',
} as const;

/** A lease refusal in its one wording: the cause's reason, the operation's fix. */
export interface LeaseVerdict {
  readonly code: RuntimeRefusalCode;
  readonly reason: string;
  readonly fix: string;
}

export function leaseVerdict(cause: LeaseCause, fix: string): LeaseVerdict {
  return { ...REASONS[cause], fix };
}

export function refuseLease(cause: LeaseCause, fix: string): RuntimeResult<never> {
  const verdict = leaseVerdict(cause, fix);
  return refuse(verdict.code, verdict.reason, verdict.fix);
}

/** The lease row as the owning transaction reads it under its locks. */
export interface LeaseRow {
  readonly task_id: string;
  readonly state: string;
  readonly fence: string;
  readonly holder_actor_id: string;
  readonly delegation_id: string | null;
  readonly expired: boolean;
  readonly current_fence: string;
  readonly delegation_live: boolean;
}

/**
 * Read under the lease lock, with expiry judged at `lockedAt`, the clock read
 * after the locks: a call that waited on them past the expiry sees it expired.
 */
export async function readLease(
  tx: TenantQuery,
  leaseId: string,
  lockedAt: string,
): Promise<LeaseRow | undefined> {
  const rows = await tx.query<LeaseRow>(
    `select l.task_id, l.state, l.fence::text as fence, l.holder_actor_id, l.delegation_id,
            (l.expires_at <= $3::timestamptz) as expired,
            (select max(fence) from public.leases
              where business_id = l.business_id and task_id = l.task_id)::text as current_fence,
            exists (select 1 from public.delegations d
                     where d.business_id = l.business_id and d.id = l.delegation_id
                       and d.revoked_at is null and d.settled_at is null
                       and d.expires_at > $3::timestamptz) as delegation_live
       from public.leases l where l.business_id = $1 and l.id = $2`,
    [tx.businessId, leaseId, lockedAt],
  );
  return rows[0];
}

/**
 * Who is calling. A person's own lease carries no delegation, so a person
 * presents none and an agent's lease is never theirs (EX-01). An agent that
 * presents the delegation its credential resolved to must present exactly the
 * lease's.
 */
export type LeaseClaimant =
  | { readonly claimant: 'agent'; readonly actorId: string; readonly delegationId?: string }
  | { readonly claimant: 'person'; readonly actorId: string };

/** EX-01: the caller is the lease's holder, of the lease's kind. */
export function holdsLease(lease: LeaseRow, caller: LeaseClaimant): boolean {
  const personLease = lease.delegation_id === null;
  if (lease.holder_actor_id !== caller.actorId) return false;
  if (personLease !== (caller.claimant === 'person')) return false;
  return (
    caller.claimant === 'person' ||
    caller.delegationId === undefined ||
    caller.delegationId === lease.delegation_id
  );
}

/**
 * The fence ladder, as a pure reading of the lease row: the presented fence is
 * the lease's, that fence is the task's newest, the lease is live, and it has
 * not expired. The first rung that fails is the cause; `null` is a current,
 * live lease.
 */
export function fenceCause(
  lease: Pick<LeaseRow, 'state' | 'fence' | 'expired' | 'current_fence'>,
  presentedFence: number,
): LeaseCause | null {
  if (Number(lease.fence) !== presentedFence) return 'fence_presented';
  if (Number(lease.fence) < Number(lease.current_fence)) return 'fence_superseded';
  if (lease.state !== 'live') return 'not_live';
  if (lease.expired) return 'expired';
  return null;
}

/** A person's own live write on the task, at the locked instant (final review R2-RUNTIME-4). */
export async function personWriteLive(
  tx: TenantQuery,
  person: { readonly subjects: readonly Subject[]; readonly collection: string },
  taskId: string,
  lockedAt: string,
): Promise<boolean> {
  const held = await checkAuthorityAt(
    tx,
    person.subjects,
    { collection: person.collection, action: 'write', scope: { kind: 'record', id: taskId } },
    lockedAt,
  );
  return held.ok;
}

/**
 * The next fence on a task: monotonic per task, computed under the task lock.
 * A sequence would be shared across tenants; this is per task and unique by
 * index.
 */
export async function nextFence(tx: TenantQuery, taskId: string): Promise<number> {
  const fences = await tx.query<{ readonly next: string }>(
    `select coalesce(max(fence), 0) + 1 as next from public.leases
      where business_id = $1 and task_id = $2`,
    [tx.businessId, taskId],
  );
  return Number(fences[0]?.next ?? 1);
}
