// SPDX-License-Identifier: AGPL-3.0-only
//
// What a list read may answer: the records a caller's live grants reach for
// one collection and action, from the same effective chain `checkAuthority`
// walks (grants.ts), so a list and a single-record check cannot disagree.

import type { TenantQuery } from '../tenancy/database.ts';
import { mapTicketCondition } from '../tasks/wayfinder.ts';
import { askedFor, EFFECTIVE, type Action, type ScopeKind, type Subject } from './grants.ts';

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
 * 14 September 2026). Party-scoped grants reach no record here. A subject held
 * within ticked keys (an agent credential) is asked only of those, as
 * `checkAuthority` asks it (`askedFor`).
 */
export async function readableScope(
  tx: TenantQuery,
  subjects: readonly Subject[],
  collection: string,
  action: Action,
): Promise<ReadableScope> {
  const asked = askedFor(subjects, { collection, action });
  const rows = await tx.query<{ readonly scope_kind: ScopeKind; readonly scope_id: string | null }>(
    `${EFFECTIVE}
     select distinct e.scope_kind, e.scope_id
       from effective e
      where e.collection = $1
        and e.action = $2
        and e.scope_kind in ('business', 'record')
        and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                     where s.kind = e.subject_kind and s.id = e.subject_id)`,
    [collection, action, asked.map((subject) => subject.kind), asked.map((subject) => subject.id)],
  );
  if (rows.some((row) => row.scope_kind === 'business')) return { business: true, records: [] };
  return {
    business: false,
    records: rows.flatMap((row) => (row.scope_id === null ? [] : [row.scope_id])),
  };
}

/**
 * Whether row `alias` is reached, judged inside the statement that reads it:
 * a live grant of the asked subjects (`kinds`, `ids`) on `collection` and
 * `action` that is business-scoped, scoped to the row, or, for `task`/`read`
 * only and when `throughMaps`, scoped to the map the row is a ticket of (W12,
 * `mapTicketCondition`), never a nested map. Party-scoped grants reach nothing here. Expiry is judged
 * by the statement's own clock (`EFFECTIVE`), so a grant that lapses before a
 * later statement reaches nothing in it.
 */
function reachedBy(
  alias: string,
  sql: { kinds: string; ids: string; collection: string; action: string },
  throughMaps: boolean,
): string {
  const throughMap = throughMaps
    ? `or (${sql.collection} = 'task' and ${sql.action} = 'read'
           and e.scope_kind = 'record' and e.scope_id = ${alias}.uuid_4
           and ${mapTicketCondition(alias)})`
    : '';
  return `exists (${EFFECTIVE}
    select 1 from effective e
     where e.business_id = ${alias}.business_id
       and e.collection = ${sql.collection} and e.action = ${sql.action}
       and exists (select 1 from unnest(${sql.kinds}, ${sql.ids}) as s (kind, id)
                    where s.kind = e.subject_kind and s.id = e.subject_id)
       and (e.scope_kind = 'business'
            or (e.scope_kind = 'record' and e.scope_id = ${alias}.id)
            ${throughMap}))`;
}

/**
 * Whether task row `alias` is readable by the subjects in parameters
 * `$firstParam` (kinds) and `$firstParam + 1` (ids), from `readableTaskParams`.
 * A list read puts this in every statement that reads task rows, or anything
 * of a task, so each row is judged at the instant it is read: a ticket moved
 * out of its granted map, or a map retyped, before a statement runs is not
 * read by it, and no lock is taken. A read that serves people outside the
 * team passes `throughMaps` false: a map and its tickets never reach a client
 * surface (WF-1).
 */
export function readableTaskCondition(
  alias: string,
  firstParam: number,
  throughMaps = true,
): string {
  return reachedBy(
    alias,
    {
      kinds: `$${String(firstParam)}::text[]`,
      ids: `$${String(firstParam + 1)}::uuid[]`,
      collection: `'task'`,
      action: `'read'`,
    },
    throughMaps,
  );
}

/**
 * Whether the subjects in `$firstParam` and `$firstParam + 1` hold a live
 * business-scoped `task`/`read` grant in `business` (SQL), judged by the
 * statement's own clock: a list read that tells its reader nothing is
 * withheld asks it in the statement that reads the rows.
 */
export function readsWholeBusiness(business: string, firstParam: number): string {
  return `exists (${EFFECTIVE}
    select 1 from effective e
     where e.business_id = ${business} and e.collection = 'task' and e.action = 'read'
       and e.scope_kind = 'business'
       and exists (select 1
                     from unnest($${String(firstParam)}::text[], $${String(firstParam + 1)}::uuid[])
                       as s (kind, id)
                    where s.kind = e.subject_kind and s.id = e.subject_id))`;
}

/**
 * The two parameters `readableTaskCondition` and `readableTaskIds` read: the
 * subjects asked of `task`/`read`, or two nulls for a caller that has judged
 * reach already (`readableTaskIds` then keeps every id).
 */
export function readableTaskParams(
  subjects: readonly Subject[] | null,
): [string[], string[]] | [null, null] {
  if (subjects === null) return [null, null];
  const asked = askedFor(subjects, { collection: 'task', action: 'read' });
  return [asked.map((subject) => subject.kind), asked.map((subject) => subject.id)];
}

/**
 * The tasks of the uuid array `ids` that are live and readable now by the
 * subjects in `$firstParam` and `$firstParam + 1` (`readableTaskParams`), or
 * every id when those are null. A statement that reads something of tasks
 * already served (their gates, time, agents, tags, comments or client) asks
 * it of this in place of `ids`, so a ticket that left its granted map, or
 * whose map was retyped, since it was served has nothing more read for it.
 */
export function readableTaskIds(ids: string, firstParam: number): string {
  return `(case when $${String(firstParam)}::text[] is null then ${ids}
     else array(select rt.id from public.records rt
                 where rt.id = any(${ids}) and rt.deleted_at is null
                   and ${readableTaskCondition('rt', firstParam)}) end)`;
}

/**
 * The live records of one type these subjects may act on in one collection,
 * worked out by the one live-grant expression (grants.ts), inside the query.
 *
 * A read that works over many records filters by this list rather than
 * reading every record and checking each afterwards, so a record the subjects
 * hold no grant on never leaves the database. A business grant reaches every
 * record; a record grant, its one record, and for `task`/`read` a map's grant
 * its tickets too (`reachedBy`). A party grant is not read here, as
 * `checkAuthority` does not read it for a record either, so the list is
 * exactly the records a single-record check would admit, a subject held
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
    `select r.id
       from public.records r
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and ${reachedBy('r', { kinds: '$5::text[]', ids: '$6::uuid[]', collection: '$3::text', action: '$4::text' }, true)}`,
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
