// SPDX-License-Identifier: AGPL-3.0-only
//
// Reading the inbox (INB-1d): one recipient's items as they may be shown now,
// access derived from their live grants inside the read's own query, and the
// owed count under the same rule. The closed history's page is found from the
// grants' side, so an item about a task the recipient cannot read is never
// looked at for it, and the withheld history beside the page is read on its
// own, bounded: neither read grows with a person's history. Raising and
// recording are `items.ts`.

import { readScopes, type InboxAccess } from './access.ts';
import type { Disclosed, InboxAlert, InboxItem, InboxItemAxes } from './items.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/** The newest closed items the list carries, after every open one. */
export const INBOX_HISTORY_PAGE = 50;

/**
 * The most closed items the withheld history looks at. Withheld items never
 * take a place in the page, which is read on its own; this bounds the read of
 * those beside it.
 */
export const INBOX_HISTORY_SCAN: number = 4 * INBOX_HISTORY_PAGE;

/** A row as read: the axes, the pointers, and the facts access is derived from. */
type ItemRow = InboxItemAxes &
  Omit<Disclosed, 'alert'> & {
    readonly trashed: boolean;
    readonly held: boolean;
    readonly alertId: string | null;
    readonly alertKind: InboxAlert['kind'] | null;
    readonly alertReason: InboxAlert['waitingReason'];
    readonly alertAt: Date | null;
  };

/**
 * Where the recipient reads tasks now, as the three parameters a query filters
 * on itself: the same grants `taskAccess` asks, listed once for every row.
 */
const HELD = `($3::boolean or i.subject_record_id = any($4::uuid[]) or r.uuid_7 = any($5::uuid[]))`;

async function reach(tx: TenantQuery, personId: string): Promise<readonly unknown[]> {
  const scopes = await readScopes(tx, personId);
  return [tx.businessId, personId, scopes.business, scopes.records, scopes.parties];
}

/** An item's own columns, as `shown` carries them before trashed and held. */
const COLUMNS = `i.id, i.business_id, i.recipient_person_id, i.subject_record_id, i.reason,
       i.fact_kind, i.fact_id, i.owed, i.work_state, i.raised_at, i.closed_at,
       i.closed_by_person_id`;

/** Every open item, access derived per row. */
const OPEN = `select ${COLUMNS}, r.deleted_at is not null as trashed, ${HELD} as held
         from public.inbox_items i
         join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
        where i.business_id = $1 and i.recipient_person_id = $2 and i.work_state = 'open'`;

/**
 * The page: the newest $6 closed items about a task the recipient reads now,
 * found from the grants' side. A business-wide read takes the history index
 * (0044) as it stands. Otherwise each task the grants reach, named or through
 * its client, gives at most $6 of its newest items on the subject history
 * index (0044), and the newest $6 of those are the page. A closed item about
 * a task the recipient cannot read is never looked at, so it takes no place.
 */
const PAGE = `select * from (
         (select ${COLUMNS}, r.deleted_at is not null as trashed, true as held
            from public.inbox_items i
            join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
           where $3::boolean and i.business_id = $1 and i.recipient_person_id = $2
             and i.work_state <> 'open'
           order by i.closed_at desc, i.id desc
           limit $6)
         union all
         (select h.*
            from public.records r
            cross join lateral (
              select ${COLUMNS}, r.deleted_at is not null as trashed, true as held
                from public.inbox_items i
               where i.business_id = r.business_id and i.recipient_person_id = $2
                 and i.subject_record_id = r.id and i.work_state <> 'open'
               order by i.closed_at desc, i.id desc
               limit $6) h
           where not $3::boolean and r.business_id = $1
             and (r.id = any($4::uuid[]) or r.uuid_7 = any($5::uuid[]))
           order by h.closed_at desc, h.id desc
           limit $6)
       ) page`;

/**
 * The withheld history beside the page: closed items about a task the
 * recipient cannot read now, closed no earlier than the page's oldest item
 * ($6, `-infinity` while the page is not full), among the newest $7 closed
 * items on the history index (0044), which the scan starts and stops on.
 */
const WITHHELD = `shown as (
       select ${COLUMNS}, r.deleted_at is not null as trashed, false as held
         from (select ${COLUMNS}
                 from public.inbox_items i
                where i.business_id = $1 and i.recipient_person_id = $2
                  and i.work_state <> 'open' and i.closed_at >= $6::text::timestamptz
                order by i.closed_at desc, i.id desc
                limit $7) i
         join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
        where not ${HELD}
     )`;

/**
 * The rows of `shown` as the item carries them, access and alert derived here.
 * An item about a planned run carries T2h's latest alert on that run.
 */
const listing = (ctes: string): string => `with ${ctes}
     select s.id, s.recipient_person_id as "recipientPersonId",
            s.subject_record_id as "subjectRecordId", s.reason, s.fact_kind as "factKind",
            s.fact_id as "factId", s.owed, s.work_state as "workState", s.raised_at as "raisedAt",
            s.closed_at as "closedAt", s.closed_by_person_id as "closedByPersonId",
            a.seen_at as "seenAt",
            (select d.state from public.inbox_delivery_attempts d
              where d.business_id = s.business_id and d.item_id = s.id
              order by d.observed_seq desc limit 1) as "lastDelivery",
            s.trashed, s.held, al.id as "alertId", al.kind as "alertKind",
            al.waiting_reason as "alertReason", al.raised_at as "alertAt"
       from shown s
       left join public.inbox_attention a on a.business_id = s.business_id and a.item_id = s.id
       left join lateral (
         select x.id, x.kind, x.waiting_reason, x.raised_at
           from public.alerts x
          where s.fact_kind = 'planned_run' and s.held
            and x.business_id = s.business_id and x.task_id = s.subject_record_id
            and (x.cause_id in (select t.id from public.attempts t
                                  join public.reservations v
                                    on v.business_id = t.business_id and v.id = t.reservation_id
                                 where t.business_id = s.business_id and v.run_id = s.fact_id)
                 or x.cause_id = (select p.lineage_id from public.planned_runs p
                                   where p.business_id = s.business_id and p.id = s.fact_id))
          order by x.raised_at desc, x.id
          limit 1
       ) al on true
      order by s.raised_at, s.id`;

/** Every open item and the page. */
const ITEMS = listing(`shown as (${OPEN}\n       union all\n       ${PAGE})`);

/**
 * What one recipient can be shown, each axis read separately and access derived
 * in the same query: every open item, and the newest `INBOX_HISTORY_PAGE`
 * closed ones about a task they read now, found from their grants so a
 * withheld item takes no place in the page; then, in a read of its own, every
 * closed item since the page's oldest that is about a task they cannot
 * read, back as withheld (withheld is not gone), among the newest
 * `INBOX_HISTORY_SCAN` closed items. Neither read looks further, so the work
 * does not grow with history. The recipient is the only person whose items
 * come back: each query names them, and the attention row it joins is theirs
 * by its foreign key. Oldest raised first.
 *
 * An item about a planned run carries T2h's latest alert on that run: one
 * whose cause is an attempt under the run's reservation (a settlement or a
 * hand-back) or the run's lineage (a cancellation). The alert is disclosed
 * only on a readable item, as the task page shows it.
 */
export async function readInboxItems(
  tx: TenantQuery,
  recipientPersonId: string,
): Promise<readonly InboxItem[]> {
  const reached = await reach(tx, recipientPersonId);
  const shown = await tx.query<ItemRow>(ITEMS, [...reached, INBOX_HISTORY_PAGE]);
  const page = shown.flatMap((row) => (row.closedAt === null ? [] : [row.closedAt.getTime()]));
  // As text: the driver writes a timestamp parameter through `Date`, which has no infinity.
  const edge =
    page.length < INBOX_HISTORY_PAGE ? '-infinity' : new Date(Math.min(...page)).toISOString();
  const withheld = await tx.query<ItemRow>(listing(WITHHELD), [
    ...reached,
    edge,
    INBOX_HISTORY_SCAN,
  ]);
  return [...shown, ...withheld].toSorted(byRaised).map((row) => itemOf(row));
}

/** Oldest raised first, as one query's `order by raised_at, id` would have it. */
const byRaised = (a: ItemRow, b: ItemRow): number =>
  a.raisedAt.getTime() - b.raisedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One row as the recipient may be shown it: pointers and the alert only while readable. */
function itemOf(row: ItemRow): InboxItem {
  const { trashed, held, subjectRecordId, factId, closedByPersonId, ...rest } = row;
  const { alertId, alertKind, alertReason, alertAt, ...axes } = rest;
  const access: InboxAccess = held ? (trashed ? 'gone' : 'readable') : 'withheld';
  if (access !== 'readable') return { ...axes, access };
  const alert: InboxAlert | null =
    alertId === null || alertKind === null || alertAt === null
      ? null
      : {
          id: alertId,
          kind: alertKind,
          waitingReason: alertReason,
          raisedAt: alertAt.toISOString(),
        };
  return { ...axes, access, subjectRecordId, factId, closedByPersonId, alert };
}

/**
 * The owed count, in one query under the list's own rule: open, owed, and about
 * a task the recipient reads now that is not trashed. Every open item is on the
 * list, so this equals the list's counted entries.
 */
export async function countOwedItems(tx: TenantQuery, recipientPersonId: string): Promise<number> {
  const rows = await tx.query<{ readonly owed: number }>(
    `select count(*)::int as owed
       from public.inbox_items i
       join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
      where i.business_id = $1 and i.recipient_person_id = $2
        and i.work_state = 'open' and i.owed and r.deleted_at is null and ${HELD}`,
    await reach(tx, recipientPersonId),
  );
  return rows[0]?.owed ?? 0;
}
