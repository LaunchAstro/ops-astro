// SPDX-License-Identifier: AGPL-3.0-only
//
// The scopes a holder's grants reach (C31, MP-14-7a, MP-14-8, MP-14-10a),
// computed from the same effective-grants walk as every check, inside the
// transaction that serves the read.

import type { TenantQuery } from '../tenancy/database.ts';
import {
  EFFECTIVE_GRANTS_CTE,
  type Action,
  type Scope,
  type ScopeKind,
  type Subject,
} from './grants.ts';

/**
 * The scopes at which these subjects hold `collection:action` right now: the
 * business, or the parties and records they were granted. A list read filters
 * its rows by these inside its own statement, in the serving transaction, so
 * a party-scoped holder sees that party's rows and nobody else's.
 */
export async function grantedScopes(
  tx: TenantQuery,
  subjects: readonly Subject[],
  collection: string,
  action: Action,
): Promise<readonly Scope[]> {
  const rows = await tx.query<{ readonly scope_kind: ScopeKind; readonly scope_id: string | null }>(
    `${EFFECTIVE_GRANTS_CTE}
     select distinct e.scope_kind, e.scope_id
       from effective e
      where e.collection = $1
        and e.action = $2
        and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                     where s.kind = e.subject_kind and s.id = e.subject_id)`,
    [
      collection,
      action,
      subjects.map((subject) => subject.kind),
      subjects.map((subject) => subject.id),
    ],
  );
  return rows.map((row) => ({ kind: row.scope_kind, id: row.scope_id }));
}
