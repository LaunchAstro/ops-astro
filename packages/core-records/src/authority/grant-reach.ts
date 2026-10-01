// SPDX-License-Identifier: AGPL-3.0-only
//
// Who and where an effective grant reaches, through the same walk as
// `effectiveGrants` (`grants.ts`): the scopes a caller holds an action at, and
// the people a grant for a request reaches. The inbox asks both (INB-1b,
// INB-1e); nothing here caches.

import {
  EFFECTIVE,
  type Action,
  type Scope,
  type ScopeKind,
  type ScopeRequest,
  type Subject,
} from './grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/**
 * Every scope at which these subjects hold `collection:action` now, through
 * the same walk as `effectiveGrants`. For a read that filters its rows inside
 * its own query, so a row outside the caller's reach is never returned to it
 * (INB-1e's unattended list).
 */
export async function grantedScopes(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: { readonly collection: string; readonly action: Action },
): Promise<readonly Scope[]> {
  const rows = await tx.query<{ readonly kind: ScopeKind; readonly id: string | null }>(
    `${EFFECTIVE}
     select distinct e.scope_kind as kind, e.scope_id as id
       from effective e
      where e.collection = $1
        and e.action = $2
        and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                     where s.kind = e.subject_kind and s.id = e.subject_id)`,
    [
      request.collection,
      request.action,
      subjects.map((subject) => subject.kind),
      subjects.map((subject) => subject.id),
    ],
  );
  return rows.map((row) => ({ kind: row.kind, id: row.id }));
}

/**
 * The people an effective grant for this request reaches: a person named on
 * the grant, or the person behind an actor it names. Nothing in this head
 * gives a group members, so a group grant reaches nobody here.
 */
export async function grantHolders(
  tx: TenantQuery,
  request: ScopeRequest,
): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly person_id: string }>(
    `${EFFECTIVE}
     select distinct coalesce(a.person_id, e.subject_id) as person_id
       from effective e
       left join public.actors a
         on e.subject_kind = 'actor' and a.business_id = e.business_id
        and a.id = e.subject_id and a.kind = 'person' and a.active
      where e.collection = $1 and e.action = $2
        and (e.subject_kind = 'person' or a.person_id is not null)
        and (e.scope_kind = 'business' or (e.scope_kind = $3 and e.scope_id = $4::uuid))
      order by 1`,
    [request.collection, request.action, request.scope.kind, request.scope.id],
  );
  return rows.map((row) => row.person_id);
}
