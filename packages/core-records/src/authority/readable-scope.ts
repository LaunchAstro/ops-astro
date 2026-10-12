// SPDX-License-Identifier: AGPL-3.0-only
//
// What a list read may answer: the records a caller's live grants reach for
// one collection and action, from the same effective chain `checkAuthority`
// walks (grants.ts), so a list and a single-record check cannot disagree. A
// `task:read` grant on a map also reaches the map's tickets, never a nested
// map (W12), as `task.read` admits them (`reads/dispatch.ts`), and holds each
// of them as that read does. No other action reaches through a map: a decide
// on a ticket's gate asks the ticket's own grant.

import type { TenantQuery } from '../tenancy/database.ts';
import { mapTicketCondition } from '../tasks/wayfinder.ts';
import { askedFor, EFFECTIVE, type Action, type ScopeKind, type Subject } from './grants.ts';

/** What a caller's live grants reach for one collection and action. */
export interface ReadableScope {
  /** A business-scoped grant: every record of the collection. */
  readonly business: boolean;
  /**
   * The records reached by record-scoped grants, when there is no business
   * grant: each granted record and, for `task:read`, each ticket of a granted
   * map.
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
  const first = await grantedScopes(tx, asked, collection, action);
  if (first === 'business') return { business: true, records: [] };
  const tickets = collection === 'task' && action === 'read' ? await heldTickets(tx, first) : [];
  if (tickets.length === 0) return { business: false, records: first };
  // The ticket locks may have waited past a grant's expiry: judged again on
  // this statement's clock, after the wait, a grant that lapsed reaches
  // neither its record nor its map's tickets.
  const live = await stillGranted(tx, asked, { collection, action }, first);
  if (live === 'business') return { business: true, records: [] };
  return {
    business: false,
    records: [
      ...first.filter((id) => live.has(id)),
      ...tickets.flatMap((ticket) => (live.has(ticket.map) ? [ticket.id] : [])),
    ],
  };
}

/** The records `asked`'s live grants name for this key, or `business` for a business grant. */
async function grantedScopes(
  tx: TenantQuery,
  asked: readonly Subject[],
  collection: string,
  action: Action,
): Promise<'business' | readonly string[]> {
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
  if (rows.some((row) => row.scope_kind === 'business')) return 'business';
  return rows.flatMap((row) => (row.scope_id === null ? [] : [row.scope_id]));
}

/**
 * Which of `ids` `asked`'s live grants still name for this key, judged on
 * this statement's clock, or `business` for a business grant.
 */
async function stillGranted(
  tx: TenantQuery,
  asked: readonly Subject[],
  key: { readonly collection: string; readonly action: Action },
  ids: readonly string[],
): Promise<'business' | ReadonlySet<string>> {
  const rows = await tx.query<{ readonly scope_kind: ScopeKind; readonly scope_id: string | null }>(
    `${EFFECTIVE}
     select e.scope_kind, e.scope_id
       from effective e
      where e.collection = $1
        and e.action = $2
        and (e.scope_kind = 'business' or (e.scope_kind = 'record' and e.scope_id = any($5::uuid[])))
        and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                     where s.kind = e.subject_kind and s.id = e.subject_id)`,
    [
      key.collection,
      key.action,
      asked.map((subject) => subject.kind),
      asked.map((subject) => subject.id),
      ids,
    ],
  );
  if (rows.some((row) => row.scope_kind === 'business')) return 'business';
  return new Set(rows.flatMap((row) => (row.scope_id === null ? [] : [row.scope_id])));
}

/**
 * The tickets of whichever of `ids` are maps, each with its map, held `for
 * share` in id order as `task.read` holds a ticket it admits through its map,
 * so none moves out of the map before the read that listed it is served.
 */
async function heldTickets(
  tx: TenantQuery,
  ids: readonly string[],
): Promise<readonly { readonly id: string; readonly map: string }[]> {
  if (ids.length === 0) return [];
  return await tx.query<{ readonly id: string; readonly map: string }>(
    `select t.id, t.uuid_4 as map from public.records t
      where t.business_id = $1 and t.uuid_4 = any($2::uuid[]) and ${mapTicketCondition('t')}
      order by t.id
      for share of t`,
    [tx.businessId, ids],
  );
}

/**
 * The live records of one type these subjects may act on in one collection,
 * worked out by the one live-grant expression (grants.ts), inside the query.
 *
 * A read that works over many records (the derived rank's pool) filters by
 * this list rather than reading every record and checking each afterwards, so
 * a record the subjects hold no grant on never leaves the database. A business
 * grant reaches every record; a record grant, its one record, and a
 * `task:read` grant on a map each of the map's tickets (W12), held as
 * `readableScope` holds them. A party grant is not read
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
  const scope = await readableScope(tx, subjects, request.collection, request.action);
  const rows = await tx.query<{ readonly id: string }>(
    `select r.id from public.records r
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and ($3 or r.id = any($4::uuid[]))`,
    [tx.businessId, request.recordTypeId, scope.business, scope.records],
  );
  return rows.map((row) => row.id);
}
