// SPDX-License-Identifier: AGPL-3.0-only
//
// What a list read may answer: the records a caller's live grants reach for
// one collection and action, from the same effective chain `checkAuthority`
// walks (grants.ts), so a list and a single-record check cannot disagree. A
// task grant on a map reaches the map's tickets too, never a nested map
// (W12), as `task.read` admits them (`reads/dispatch.ts`).

import type { TenantQuery } from '../tenancy/database.ts';
import { mapTicketCondition } from '../tasks/wayfinder.ts';
import { askedFor, EFFECTIVE, type Action, type ScopeKind, type Subject } from './grants.ts';

/** What a caller's live grants reach for one collection and action. */
export interface ReadableScope {
  /** A business-scoped grant: every record of the collection. */
  readonly business: boolean;
  /**
   * The records reached by record-scoped grants, when there is no business
   * grant: each granted record, and each ticket of a granted map.
   */
  readonly records: readonly string[];
}

/**
 * The records a list read may answer, from the same effective chain the check
 * uses. A list read filters by this inside its query and counts the rest as
 * withheld, never naming them (the withheld count, records and authority,
 * 14 September 2026). Party-scoped grants reach no record here. A subject held
 * within ticked keys (an agent credential) is asked only of those, as
 * `checkAuthority` asks it (`askedFor`). A list read matches its rows against
 * `records` by id alone: a map's tickets are already in it.
 */
export async function readableScope(
  tx: TenantQuery,
  subjects: readonly Subject[],
  collection: string,
  action: Action,
): Promise<ReadableScope> {
  const asked = askedFor(subjects, { collection, action });
  const rows = await tx.query<{ readonly scope_kind: ScopeKind; readonly scope_id: string | null }>(
    `${EFFECTIVE}, held as (
       select distinct e.scope_kind, e.scope_id
         from effective e
        where e.collection = $1
          and e.action = $2
          and e.scope_kind in ('business', 'record')
          and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                       where s.kind = e.subject_kind and s.id = e.subject_id))
     select scope_kind, scope_id from held
     union
     select 'record', t.id
       from held h
       join public.records t on t.business_id = $5 and t.uuid_4 = h.scope_id
      where $1 = 'task' and h.scope_kind = 'record' and ${mapTicketCondition('t')}`,
    [
      collection,
      action,
      asked.map((subject) => subject.kind),
      asked.map((subject) => subject.id),
      tx.businessId,
    ],
  );
  if (rows.some((row) => row.scope_kind === 'business')) return { business: true, records: [] };
  return {
    business: false,
    records: rows.flatMap((row) => (row.scope_id === null ? [] : [row.scope_id])),
  };
}

/**
 * The live records of one type these subjects may act on in one collection,
 * worked out by the one live-grant expression (grants.ts), inside the query.
 *
 * A read that works over many records (the derived rank's pool) filters by
 * this list rather than reading every record and checking each afterwards, so
 * a record the subjects hold no grant on never leaves the database. A business
 * grant reaches every record; a record grant, its one record, and a task
 * grant on a map each of the map's tickets (W12). A party grant is not read
 * here, as `checkAuthority` does not read it for a record either, so the list
 * is exactly the records a single-record read would admit, a subject held
 * within ticked keys included.
 */
export async function readableRecordIds(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: {
    readonly collection: string;
    readonly action: Action;
    readonly recordTypeId: string;
  },
): Promise<readonly string[]> {
  const asked = askedFor(subjects, request);
  const rows = await tx.query<{ readonly id: string }>(
    `${EFFECTIVE}
     select r.id
       from public.records r
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and exists (
          select 1 from effective e
           where e.collection = $3
             and e.action = $4
             and exists (select 1 from unnest($5::text[], $6::uuid[]) as s (kind, id)
                          where s.kind = e.subject_kind and s.id = e.subject_id)
             and (e.scope_kind = 'business'
                  or (e.scope_kind = 'record' and e.scope_id = r.id)
                  or (e.scope_kind = 'record' and e.collection = 'task' and e.scope_id = r.uuid_4
                      and ${mapTicketCondition('r')})))`,
    [
      tx.businessId,
      request.recordTypeId,
      request.collection,
      request.action,
      asked.map((subject) => subject.kind),
      asked.map((subject) => subject.id),
    ],
  );
  return rows.map((row) => row.id);
}
