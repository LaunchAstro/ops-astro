// SPDX-License-Identifier: AGPL-3.0-only
//
// Which scopes a caller holds a key at (C1), read through the grant check's
// own walk (`EFFECTIVE` in grants.ts).

import type { TenantQuery } from '../tenancy/database.ts';
import { EFFECTIVE, type Scope, type ScopeRequest, type Subject } from './grants.ts';

/**
 * Every live grant of this collection and action, at whatever scope it names.
 *
 * `effectiveGrants` answers "is this one scope covered"; a search asks the
 * other question, "which scopes are", so the answer can be a predicate of the
 * statement that finds candidates rather than a filter over what it found
 * (ticket C1, CS-2.4). Same `EFFECTIVE`, so a delegated
 * grant whose parent was revoked is as dead here as it is there.
 */
export async function heldScopes(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: Omit<ScopeRequest, 'scope'>,
): Promise<readonly Scope[]> {
  return await tx.query<Scope>(
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
}
