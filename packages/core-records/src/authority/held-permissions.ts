// SPDX-License-Identifier: AGPL-3.0-only
//
// Every live grant in a business and the person each one names, read through
// the grant check's own walk (`EFFECTIVE` in grants.ts).

import type { TenantQuery } from '../tenancy/database.ts';
import { EFFECTIVE, type Action, type Scope, type ScopeKind } from './grants.ts';

/** One live grant and the person it names. */
export interface HeldPermission {
  /** The grant row it comes from, what `access.revoke` takes. */
  readonly grantId: string;
  readonly personId: string;
  /** Named on the grant as the person, rather than reached through their acting identity. */
  readonly direct: boolean;
  /** The acting identity the grant names, or null when it names the person. */
  readonly actorId: string | null;
  readonly collection: string;
  readonly action: Action;
  readonly scope: Scope;
  /**
   * Named on an acting identity no longer active: listed so it can be found
   * and revoked, and no authority, as no sign-in acts through that identity.
   */
  readonly dormant: boolean;
}

/**
 * Every live grant in this business, with its person: the person the grant
 * names, or the person behind the acting identity it names. It is
 * `EFFECTIVE`, the walk `effectiveGrants` asks, so what it answers is what
 * the grant check grants. A grant on an inactive acting identity grants
 * nothing, so it is left out unless `dormant` asks for it, and then marked:
 * a list of grants to revoke takes it, and a preview or a rank check never
 * does. A group grant reaches nobody here, because no group has members yet.
 */
export async function heldPermissions(
  tx: TenantQuery,
  { dormant = false }: { readonly dormant?: boolean } = {},
): Promise<readonly HeldPermission[]> {
  const rows = await tx.query<{
    readonly grant_id: string;
    readonly person_id: string;
    readonly direct: boolean;
    readonly actor_id: string | null;
    readonly collection: string;
    readonly action: Action;
    readonly scope_kind: ScopeKind;
    readonly scope_id: string | null;
    readonly dormant: boolean;
  }>(
    `${EFFECTIVE}
     select distinct e.id as grant_id, coalesce(a.person_id, e.subject_id) as person_id,
            e.subject_kind = 'person' as direct, a.id as actor_id,
            e.collection, e.action, e.scope_kind, e.scope_id,
            e.subject_kind = 'actor' and not a.active as dormant
       from effective e
       left join public.actors a
         on e.subject_kind = 'actor' and a.business_id = e.business_id
        and a.id = e.subject_id and a.kind = 'person'
      where e.business_id = $1
        and (e.subject_kind = 'person' or a.person_id is not null)
        and ($2 or e.subject_kind = 'person' or a.active)
      order by 2, 5, 6, 7, 8, 1`,
    [tx.businessId, dormant],
  );
  return rows.map((row) => ({
    grantId: row.grant_id,
    personId: row.person_id,
    direct: row.direct,
    actorId: row.actor_id,
    collection: row.collection,
    action: row.action,
    scope: { kind: row.scope_kind, id: row.scope_id },
    dormant: row.dormant,
  }));
}
