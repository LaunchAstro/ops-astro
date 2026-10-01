// Where a caller's grants reach, for a list read that filters inside its own
// statement (MP-6-4). Beside `grants.ts`, which owns the expression it reads.

import type { TenantQuery } from '../tenancy/database.ts';
import { EFFECTIVE, type Action, type Subject } from './grants.ts';

/**
 * Where the caller holds this collection and action right now: the whole
 * business, or the records its record-scoped grants name. A list read hands
 * both to its own query, so the rows it returns are filtered by the caller's
 * grant inside the statement that reads them.
 */
export interface CoveredScopes {
  readonly business: boolean;
  readonly records: readonly string[];
}

export async function coveredScopes(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: { readonly collection: string; readonly action: Action },
): Promise<CoveredScopes> {
  const rows = await tx.query<{ readonly scope_kind: string; readonly scope_id: string | null }>(
    `${EFFECTIVE}
     select distinct e.scope_kind, e.scope_id
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
  return {
    business: rows.some((row) => row.scope_kind === 'business'),
    records: rows.flatMap((row) =>
      row.scope_kind === 'record' && row.scope_id !== null ? [row.scope_id] : [],
    ),
  };
}
