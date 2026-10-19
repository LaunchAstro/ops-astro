// SPDX-License-Identifier: AGPL-3.0-only
//
// A worker's live lease, held for a subject on its task: C80's receipt (`correction-receipts.ts`)
// and C57's change request made a task (`review/change-requests.ts`, #2117) ask the one check.

import type { TenantQuery } from '../tenancy/database.ts';
import { checkDelegatedAuthority, resolveLiveById } from '../authority/delegations.ts';
import type { Delegation } from '../authority/delegations.ts';
import { holdOwnWrite, ownWriteStands, type OwnHeld } from './covering.ts';

export type ObservedRefusal =
  'LEASE_NOT_OWNED' | 'DELEGATION_NARROWED' | 'NOT_FOUND' | 'GATE_NOT_APPROVED';
export type Refused = { readonly ok: false; readonly code: ObservedRefusal };
type OwnedLease = { readonly task_id: string; readonly delegation_id: string | null };

/** The lease a worker names: its id, the fence it holds and its own actor. */
export interface LeaseAt {
  readonly leaseId: string;
  readonly fence: number;
  readonly actorId: string;
}

/**
 * The subject locked, and a live worker lease on its task at the fence the worker holds, or the
 * refusal: no such lease of the caller's is `LEASE_NOT_OWNED` whatever the id; a subject `lock`
 * finds absent or on another task, `NOT_FOUND`. The lease and then its delegation are
 * locked `for share` (`core-runtime/src/locks.ts`'s order), so neither can end or be revoked
 * until this transaction does; then the clock is read once, after the locks, and both
 * expiries are judged at it (`core-runtime/src/clock.ts`). The lease is the caller's own, and
 * its delegation, where it has one, is not revoked, settled or expired (the check
 * `core-runtime/src/lease-ownership.ts` makes). The lease then stands on its person's grants,
 * share-locked after the subject and before the lease: a delegated one on the delegating
 * person's (`holdPersonWrites`, `delegatedWriteStands`), a person's own on their own task
 * write (`holdOwnWrite`, `ownWriteStands`).
 */
export async function holdTaskLease<T>(
  tx: TenantQuery,
  at: LeaseAt,
  lock: (taskId: string) => Promise<T | undefined>,
): Promise<{ readonly ok: true; readonly subject: T } | Refused> {
  // The lease the caller holds names the one task it may reach, asked before any subject:
  // another task's subject and an id that names none get the same answer.
  const [owned] = await tx.query<OwnedLease>(
    `select l.task_id, l.delegation_id from public.leases l
      where l.business_id = $1 and l.id = $2 and l.fence = $3 and l.holder_actor_id = $4`,
    [tx.businessId, at.leaseId, at.fence, at.actorId],
  );
  if (owned === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  const subject = await lock(owned.task_id);
  if (subject === undefined) return { ok: false, code: 'NOT_FOUND' };
  const person = await holdPersonWrites(tx, at.actorId, owned);
  if (person === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  const [lease] = await tx.query<{ readonly delegation_id: string | null }>(
    `select l.delegation_id from public.leases l
      where l.business_id = $1 and l.id = $2 and l.task_id = $3 and l.fence = $4
        and l.holder_actor_id = $5
      for share of l`,
    [tx.businessId, at.leaseId, owned.task_id, at.fence, at.actorId],
  );
  if (lease === undefined || lease.delegation_id !== owned.delegation_id) {
    return { ok: false, code: 'LEASE_NOT_OWNED' };
  }
  if (lease.delegation_id !== null) {
    await tx.query(
      `select 1 from public.delegations where business_id = $1 and id = $2 for share`,
      [tx.businessId, lease.delegation_id],
    );
  }
  const live = await tx.query<{ readonly at: string }>(
    `with instant as materialized (select clock_timestamp() as at)
     select instant.at::text as at from public.leases l, instant
      where l.business_id = $1 and l.id = $2 and l.state = 'live' and l.expires_at > instant.at
        and (l.delegation_id is null or exists (
              select 1 from public.delegations d
               where d.business_id = l.business_id and d.id = l.delegation_id
                 and d.revoked_at is null and d.settled_at is null and d.expires_at > instant.at))`,
    [tx.businessId, at.leaseId],
  );
  const [instant] = live;
  if (instant === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  const stands = await delegatedWriteStands(tx, person, instant.at);
  if (!stands.ok) return stands;
  return { ok: true, subject };
}

interface PersonHeld {
  readonly delegation: Delegation;
  readonly held: readonly string[];
}

/**
 * The live delegation, and the ids of the grants `checkDelegatedAuthority`
 * reads for it share-locked, with their parents, in id order in one statement:
 * the person's writes on its collections, at the business or its purpose record
 * (a child draws on its parent's person; both fixed at mint, 0100). Taken
 * after the subject row, as `lockCoveredCorrection` takes its grants, and
 * before the lease and delegation (`core-runtime/src/locks.ts`): a revocation
 * that committed first is seen after the locks, a later one waits for the
 * commit, and a grant issued after this statement is not held.
 */
async function holdPersonWrites(
  tx: TenantQuery,
  actorId: string,
  lease: OwnedLease,
): Promise<PersonHeld | OwnHeld | undefined> {
  if (lease.delegation_id === null) return await holdOwnWrite(tx, actorId, lease.task_id);
  const delegation = await resolveLiveById(tx, actorId, lease.delegation_id);
  if (delegation === undefined) return undefined;
  const rows = await tx.query<{ readonly id: string }>(
    `with recursive chain as (
       select g.id, g.parent_grant_id from public.grants g
        where g.business_id = $1 and g.subject_kind = 'person' and g.subject_id = $2
          and g.collection = any($3::text[]) and g.action = 'write'
          and (g.scope_kind = 'business' or (g.scope_kind = $4 and g.scope_id = $5::uuid))
       union
       select p.id, p.parent_grant_id from public.grants p
         join chain c on p.id = c.parent_grant_id
        where p.business_id = $1
     )
     select g.id from public.grants g
      where g.business_id = $1 and g.id in (select id from chain)
      order by g.id
      for share`,
    [
      tx.businessId,
      delegation.delegatePersonId,
      delegation.collections,
      delegation.purposeScope.kind,
      delegation.purposeScope.id,
    ],
  );
  return { delegation, held: rows.map((row) => row.id) };
}

/**
 * A delegation's expiry is the lease's, not its person's earliest grant's, so
 * between the two the worker is narrowed (`docs/local/AUTHORITY.md`): a grant
 * revoked or past its own expiry refuses the worker's next read or write, as
 * it refuses the agent's next call. Asked through `checkDelegatedAuthority`,
 * the check a call makes, for write on every collection the delegation
 * carries on its purpose record; any one gone is `DELEGATION_NARROWED`. The
 * grants it answers are judged again at `at`, the instant read after the
 * locks, so a grant that lapsed while the caller waited no longer counts
 * (`core-runtime/src/recovery/classifier.ts`, `checkAuthorityAt`). Only
 * grants `held` count, so the answer stands until commit.
 */
async function delegatedWriteStands(
  tx: TenantQuery,
  person: PersonHeld | OwnHeld,
  at: string,
): Promise<{ readonly ok: true } | Refused> {
  if ('own' in person) return await ownWriteStands(tx, person, at);
  const { delegation, held } = person;
  for (const collection of delegation.collections) {
    // Sequential: one transaction, one connection.
    // oxlint-disable-next-line no-await-in-loop
    const reach = await checkDelegatedAuthority(tx, delegation, {
      collection,
      action: 'write',
      scope: delegation.purposeScope,
    });
    if (!reach.ok) return { ok: false, code: 'DELEGATION_NARROWED' };
    // oxlint-disable-next-line no-await-in-loop
    const live = await tx.query<{ readonly id: string }>(
      `select id from public.grants
        where business_id = $1 and id = any($2::uuid[])
          and (expires_at is null or expires_at > $3::timestamptz)`,
      [tx.businessId, reach.value.filter((id) => held.includes(id)), at],
    );
    if (live.length === 0) return { ok: false, code: 'DELEGATION_NARROWED' };
  }
  return { ok: true };
}
