// SPDX-License-Identifier: AGPL-3.0-only
//
// Every permission in effect in a business and the person each one reaches,
// read through the grant check's own walk (`EFFECTIVE` in grants.ts), so a
// preview built from it is what the check grants.

import type { TenantQuery } from '../tenancy/database.ts';
import { EFFECTIVE, type Action, type Scope, type ScopeKind } from './grants.ts';

/** One live permission and the person it reaches. */
export interface HeldPermission {
  readonly personId: string;
  /** Named on the grant as the person, rather than reached through their acting identity. */
  readonly direct: boolean;
  readonly collection: string;
  readonly action: Action;
  readonly scope: Scope;
}

/**
 * Every permission in effect in this business, with the person it reaches:
 * the person the grant names, or the person behind the acting identity it
 * names. It is `EFFECTIVE`, the walk `effectiveGrants` asks, so a preview
 * built from it is what the grant check grants. A group grant reaches nobody
 * here, because no group has members yet.
 */
export async function heldPermissions(tx: TenantQuery): Promise<readonly HeldPermission[]> {
  const rows = await tx.query<{
    readonly person_id: string;
    readonly direct: boolean;
    readonly collection: string;
    readonly action: Action;
    readonly scope_kind: ScopeKind;
    readonly scope_id: string | null;
  }>(
    `${EFFECTIVE}
     select distinct coalesce(a.person_id, e.subject_id) as person_id,
            e.subject_kind = 'person' as direct,
            e.collection, e.action, e.scope_kind, e.scope_id
       from effective e
       left join public.actors a
         on e.subject_kind = 'actor' and a.business_id = e.business_id
        and a.id = e.subject_id and a.kind = 'person' and a.active
      where e.business_id = $1
        and (e.subject_kind = 'person' or a.person_id is not null)
      order by 1, 3, 4, 5, 6`,
    [tx.businessId],
  );
  return rows.map((row) => ({
    personId: row.person_id,
    direct: row.direct,
    collection: row.collection,
    action: row.action,
    scope: { kind: row.scope_kind, id: row.scope_id },
  }));
}
