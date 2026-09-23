// SPDX-License-Identifier: AGPL-3.0-only
//
// Effective scope, computed inside the transaction that serves the call.
//
// Nothing here caches. A resolved permission set held across calls is a second
// owner of an authority the grant rows already own, and it is what makes a
// revocation bite "soon" instead of on the next call.
//
// The chain walk is what makes a manager's revocation collapse what that
// manager issued: a derived grant is effective only while its parent is
// effective and still covers it, up to a root grant. So the subset relation is
// re-checked here at use time, not trusted from grant time.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Session } from '../identity/login-resolution.ts';

export type SubjectKind = 'person' | 'group' | 'actor';
export type ScopeKind = 'business' | 'party' | 'record';
export type Action = 'read' | 'comment' | 'write' | 'assign' | 'decide' | 'share' | 'manage';

export interface Subject {
  readonly kind: SubjectKind;
  readonly id: string;
}

/** `id` is null exactly at business scope, which is the whole tenant. */
export interface Scope {
  readonly kind: ScopeKind;
  readonly id: string | null;
}

export interface ScopeRequest {
  readonly collection: string;
  readonly action: Action;
  readonly scope: Scope;
}

export type RefusalCode = 'SCOPE_NOT_GRANTED' | 'GRANT_WIDENS' | 'GRANT_DEEPENS';

/** Returned, never thrown, and carrying no value the caller was not already shown. */
export interface Refusal {
  readonly code: RefusalCode;
  readonly reason: string;
  readonly fix: string;
}

export type Decision<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };

export interface EffectiveGrant {
  readonly id: string;
  readonly scope_kind: ScopeKind;
  readonly scope_id: string | null;
  readonly can_delegate: boolean;
  readonly may_permit_delegation: boolean;
  readonly expires_at: Date | null;
}

/** A session presents two identities, and a grant may name either. */
export function subjectsOf(session: Session): readonly Subject[] {
  return [
    { kind: 'person', id: session.personId },
    { kind: 'actor', id: session.actorId },
  ];
}

// The one expression of "live, and still covered by its granter", and the
// authority. A row written around `issueGrant` is judged by this and nothing
// else, which is what lets the issue-time check name a reason without being
// the barrier.
//
// The depth guard is not decoration. `parent_grant_id` sits under the same
// UPDATE privilege that writes `revoked_at`, so a cycle is reachable, and an
// unbounded recursive term that meets a cycle does not return.
const EFFECTIVE = `
  with recursive effective as (
    select g.*, 1 as depth
      from public.grants g
     where g.parent_grant_id is null
       and g.revoked_at is null
       and (g.expires_at is null or g.expires_at > now())
    union all
    select c.*, p.depth + 1
      from public.grants c
      join effective p on p.id = c.parent_grant_id
     where p.depth < 8
       and c.revoked_at is null
       and (c.expires_at is null or c.expires_at > now())
       and p.can_delegate
       and c.collection = p.collection
       and c.action = p.action
       and (p.scope_kind = 'business'
            or (c.scope_kind = p.scope_kind and c.scope_id is not distinct from p.scope_id))
       and (not c.can_delegate or p.may_permit_delegation)
       and not c.may_permit_delegation
       and (p.expires_at is null
            or (c.expires_at is not null and c.expires_at <= p.expires_at))
  )`;

/** Every grant that authorises this request right now. Empty is a refusal, not an answer. */
export async function effectiveGrants(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: ScopeRequest,
): Promise<readonly EffectiveGrant[]> {
  return await tx.query<EffectiveGrant>(
    `${EFFECTIVE}
     select e.id, e.scope_kind, e.scope_id, e.can_delegate, e.may_permit_delegation, e.expires_at
       from effective e
      where e.collection = $1
        and e.action = $2
        and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                     where s.kind = e.subject_kind and s.id = e.subject_id)
        and (e.scope_kind = 'business'
             or (e.scope_kind = $5 and e.scope_id = $6::uuid))`,
    [
      request.collection,
      request.action,
      subjects.map((subject) => subject.kind),
      subjects.map((subject) => subject.id),
      request.scope.kind,
      request.scope.id,
    ],
  );
}

/**
 * The check a serving operation makes. A denied read says so with a code and a
 * fix; it never comes back as an empty list, because empty and denied are
 * different answers and only one of them is honest here.
 */
export async function checkAuthority(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: ScopeRequest,
): Promise<Decision<readonly EffectiveGrant[]>> {
  const grants = await effectiveGrants(tx, subjects, request);
  if (grants.length === 0) {
    return refuse('SCOPE_NOT_GRANTED', 'no live grant covers it', 'ask a holder who may delegate');
  }
  return { ok: true, value: grants };
}

export interface ProposedGrant {
  readonly subject: Subject;
  readonly scope: Scope;
  readonly collection: string;
  readonly action: Action;
  readonly canDelegate?: boolean;
  /** Only a root grant may carry it; a derived one is refused `GRANT_DEEPENS`. */
  readonly mayPermitDelegation?: boolean;
  readonly expiresAt?: Date | null;
  /** The granter's own row. Null issues a root grant, which only an admin path does. */
  readonly parentGrantId: string | null;
  readonly grantedByActorId: string;
}

/**
 * Issue a grant. A derived one must sit inside a grant its granter actually
 * holds — checked here so the refusal names the rule it broke, and checked
 * again by `EFFECTIVE` on every use, so a row that got in around this function
 * never becomes authority.
 */
export async function issueGrant(
  tx: TenantQuery,
  granter: readonly Subject[],
  proposed: ProposedGrant,
): Promise<Decision<string>> {
  const canDelegate = proposed.canDelegate ?? false;
  const mayPermit = proposed.mayPermitDelegation ?? false;
  const ends = proposed.expiresAt ?? null;

  if (proposed.parentGrantId !== null) {
    const exceeded = await exceedsGranter(tx, granter, proposed, canDelegate, mayPermit, ends);
    if (exceeded !== undefined) return exceeded;
  }

  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.grants
       (business_id, id, subject_kind, subject_id, scope_kind, scope_id, collection, action,
        can_delegate, may_permit_delegation, parent_grant_id, granted_by_actor_id, expires_at)
     values ($1, gen_random_uuid(), $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10::uuid, $11, $12)
     returning id`,
    [
      tx.businessId,
      proposed.subject.kind,
      proposed.subject.id,
      proposed.scope.kind,
      proposed.scope.id,
      proposed.collection,
      proposed.action,
      canDelegate,
      mayPermit,
      proposed.parentGrantId,
      proposed.grantedByActorId,
      ends,
    ],
  );
  const issued = rows[0];
  if (issued === undefined) throw new Error('issueGrant: the insert returned no row');
  return { ok: true, value: issued.id };
}

/** The four ways a derived grant can exceed the grant it is cut from. */
async function exceedsGranter(
  tx: TenantQuery,
  granter: readonly Subject[],
  proposed: ProposedGrant,
  canDelegate: boolean,
  mayPermit: boolean,
  ends: Date | null,
): Promise<Decision<never> | undefined> {
  if (mayPermit) return refuse('GRANT_DEEPENS', 'only a root grant may permit it', 'drop it');

  const held = await effectiveGrants(tx, granter, proposed);
  const parent = held.find((grant) => grant.id === proposed.parentGrantId);
  if (parent === undefined) {
    return refuse('GRANT_WIDENS', 'the granter holds no live grant covering it', 'narrow it');
  }
  if (!parent.can_delegate) {
    return refuse('GRANT_WIDENS', 'that grant may not be delegated', 'ask for a delegable one');
  }
  if (canDelegate && !parent.may_permit_delegation) {
    return refuse('GRANT_DEEPENS', 'the granter may not pass it on', 'drop canDelegate');
  }
  const bound = parent.expires_at;
  if (bound !== null && (ends === null || ends > bound)) {
    return refuse(
      'GRANT_WIDENS',
      'it would outlive its granter',
      `end it by ${bound.toISOString()}`,
    );
  }
  return undefined;
}

/**
 * Revocation writes a timestamp. There is no delete path, and the role has no DELETE.
 *
 * It answers with the timestamp this call wrote, or null when it wrote none
 * because the grant was already revoked or is not in this business. Callers
 * that only needed the write may ignore it; `grant.revoke` returns it.
 */
export async function revokeGrant(tx: TenantQuery, grantId: string): Promise<Date | null> {
  const rows = await tx.query<{ readonly revoked_at: Date }>(
    'update public.grants set revoked_at = now() where id = $1 and revoked_at is null returning revoked_at',
    [grantId],
  );
  return rows[0]?.revoked_at ?? null;
}

function refuse(code: RefusalCode, reason: string, fix: string): Decision<never> {
  return { ok: false, refusal: { code, reason, fix } };
}
