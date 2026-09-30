// SPDX-License-Identifier: AGPL-3.0-only
//
// What a list read may answer: the records a caller's live grants reach for
// one collection and action, from the same effective chain `checkAuthority`
// walks (grants.ts), so a list and a single-record check cannot disagree.

import type { TenantQuery } from '../tenancy/database.ts';
import { EFFECTIVE, type Action, type ScopeKind, type Subject } from './grants.ts';

/** What a caller's live grants reach for one collection and action. */
export interface ReadableScope {
  /** A business-scoped grant: every record of the collection. */
  readonly business: boolean;
  /** The records reached by record-scoped grants, when there is no business grant. */
  readonly records: readonly string[];
}

/**
 * The records a list read may answer, from the same effective chain the check
 * uses. A list read filters by this inside its query and counts the rest as
 * withheld, never naming them (the withheld count, records and authority,
 * 14 September 2026). Party-scoped grants reach no record here.
 */
export async function readableScope(
  tx: TenantQuery,
  subjects: readonly Subject[],
  collection: string,
  action: Action,
): Promise<ReadableScope> {
  const rows = await tx.query<{ readonly scope_kind: ScopeKind; readonly scope_id: string | null }>(
    `${EFFECTIVE}
     select distinct e.scope_kind, e.scope_id
       from effective e
      where e.collection = $1
        and e.action = $2
        and e.scope_kind in ('business', 'record')
        and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                     where s.kind = e.subject_kind and s.id = e.subject_id)`,
    [
      collection,
      action,
      subjects.map((subject) => subject.kind),
      subjects.map((subject) => subject.id),
    ],
  );
  if (rows.some((row) => row.scope_kind === 'business')) return { business: true, records: [] };
  return {
    business: false,
    records: rows.flatMap((row) => (row.scope_id === null ? [] : [row.scope_id])),
  };
}
