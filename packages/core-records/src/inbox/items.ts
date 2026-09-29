// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox's three records (INB-1a): the recipient's item, their attention
// row and each delivery attempt, over `migrations/0042_inbox_items.sql`.
//
// An item is a pointer to a fact that is already durable somewhere else, so
// nothing here reads or writes the fact's content. The four axes come back side
// by side and are never folded into one: work state from the item, attention
// from the recipient's own row, delivery from the attempts, and access derived
// on this read from the recipient's live grants. Read is not done, delivered is
// not seen, and withheld is not gone.

import { readScopes, taskAccess, type InboxAccess } from './access.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/** Why the item is owed to the recipient: CS-16.8's reasons, one each. */
export type InboxReason =
  | 'decision'
  | 'waiting_run'
  | 'run_finished'
  | 'assignment'
  | 'mention'
  | 'incident'
  | 'client_comment';

/** Where the fact lives. The item holds its identifier and nothing of it. */
export type InboxFactKind = 'gate' | 'planned_run' | 'record' | 'operation';

export type InboxWorkState = 'open' | 'cleared' | 'withdrawn';

export type { InboxAccess } from './access.ts';

export type DeliveryChannel = 'in_app' | 'email';

export type DeliveryState = 'asked' | 'accepted' | 'delivered' | 'failed';

export interface RaiseInboxItem {
  readonly recipientPersonId: string;
  readonly subjectRecordId: string;
  readonly reason: InboxReason;
  readonly fact: { readonly kind: InboxFactKind; readonly id: string };
}

interface InboxItemAxes {
  readonly id: string;
  readonly recipientPersonId: string;
  readonly reason: InboxReason;
  readonly factKind: InboxFactKind;
  readonly owed: boolean;
  readonly workState: InboxWorkState;
  readonly raisedAt: Date;
  readonly closedAt: Date | null;
  readonly seenAt: Date | null;
  readonly lastDelivery: DeliveryState | null;
}

/**
 * Pointers and identities come back only while the task is readable: a withheld
 * or gone item keeps the recipient's own facts and names neither the task, the
 * fact nor who closed it, so another client's item leaks no identifier of theirs.
 */
export type InboxItem =
  | (InboxItemAxes & Disclosed & { readonly access: 'readable' })
  | (InboxItemAxes & { readonly access: 'withheld' | 'gone' });

interface Disclosed {
  readonly subjectRecordId: string;
  readonly factId: string;
  readonly closedByPersonId: string | null;
  /** T2h's alert on the run the item points at, the one the task page shows; null otherwise. */
  readonly alert: InboxAlert | null;
}

/** An alert record (T2h, `core-runtime/src/alerts.ts`) as the inbox carries it. */
export interface InboxAlert {
  readonly id: string;
  readonly kind: 'settled' | 'failed' | 'cancelled' | 'awaiting_person';
  readonly waitingReason: 'needs_approval' | 'liability_unknown' | 'quarantined' | null;
  readonly raisedAt: string;
}

/** Only a finished run asks nothing back; the schema holds the same rule. */
export function owes(reason: InboxReason): boolean {
  return reason !== 'run_finished';
}

/**
 * Raise one item, or find the open one already raised for the same recipient,
 * subject, reason and fact, so a replayed transition raises nothing twice.
 */
export async function raiseInboxItem(tx: TenantQuery, item: RaiseInboxItem): Promise<string> {
  const values = [
    tx.businessId,
    item.recipientPersonId,
    item.subjectRecordId,
    item.reason,
    item.fact.kind,
    item.fact.id,
  ];
  const inserted = await tx.query<{ readonly id: string }>(
    `insert into public.inbox_items
       (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id, owed)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7)
     on conflict (business_id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id)
       where work_state = 'open' do nothing
     returning id`,
    [...values, owes(item.reason)],
  );
  const id =
    inserted[0]?.id ??
    (
      await tx.query<{ readonly id: string }>(
        `select id from public.inbox_items
          where business_id = $1 and recipient_person_id = $2 and subject_record_id = $3
            and reason = $4 and fact_kind = $5 and fact_id = $6 and work_state = 'open'`,
        values,
      )
    )[0]?.id;
  if (id === undefined) throw new Error('raiseInboxItem: neither raised nor found open');
  return id;
}

/** One observation of one attempt. Attempts never move the item. */
export async function recordDeliveryAttempt(
  tx: TenantQuery,
  attempt: {
    readonly itemId: string;
    readonly channel: DeliveryChannel;
    readonly state: DeliveryState;
    readonly evidence?: string;
  },
): Promise<string> {
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.inbox_delivery_attempts (business_id, id, item_id, channel, state, evidence)
     values ($1, gen_random_uuid(), $2, $3, $4, $5)
     returning id`,
    [tx.businessId, attempt.itemId, attempt.channel, attempt.state, attempt.evidence ?? null],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('recordDeliveryAttempt: the insert returned no row');
  return id;
}

/**
 * Stamp `seen` on the recipient's own attention row (INB-1d). The row is
 * written only for an item whose recipient is `personId` and whose task they
 * can read now, so nobody stamps another person's item or one about a task
 * they cannot read; a second stamp keeps the first. Nothing on the item moves:
 * seen leaves it open and counted. False otherwise.
 */
export async function stampSeen(
  tx: TenantQuery,
  personId: string,
  itemId: string,
): Promise<boolean> {
  const mine = await tx.query<{ readonly subject: string }>(
    `select subject_record_id as subject from public.inbox_items
      where business_id = $1 and id = $2 and recipient_person_id = $3`,
    [tx.businessId, itemId, personId],
  );
  // Opening needs read on the task now: an item about a task the recipient
  // cannot read (another client's, a lost grant) is answered as not theirs.
  const subject = mine[0]?.subject;
  if (subject === undefined || (await taskAccess(tx, personId, subject)) !== 'readable') {
    return false;
  }
  await tx.query(
    `insert into public.inbox_attention (business_id, item_id, person_id)
     values ($1, $2, $3) on conflict (business_id, item_id) do nothing`,
    [tx.businessId, itemId, personId],
  );
  return true;
}

/** The newest closed items the list carries, after every open one. */
export const INBOX_HISTORY_PAGE = 50;

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
 * on itself: the same grants `accessOf` asks, listed once for every row.
 */
const HELD = `($3::boolean or i.subject_record_id = any($4::uuid[]) or r.uuid_7 = any($5::uuid[]))`;

async function reach(tx: TenantQuery, personId: string): Promise<readonly unknown[]> {
  const scopes = await readScopes(tx, personId);
  return [tx.businessId, personId, scopes.business, scopes.records, scopes.parties];
}

/** Every open item and the newest page of held closed ones, access and alert derived here. */
const ITEMS = `with mine as (
       select i.*, r.deleted_at is not null as trashed, ${HELD} as held
         from public.inbox_items i
         join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
        where i.business_id = $1 and i.recipient_person_id = $2
     ), shown as (
       select * from mine where work_state = 'open'
       union all
       (select * from mine where work_state <> 'open' and held
         order by closed_at desc, id desc limit $6)
     )
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

/**
 * What one recipient can be shown, each axis read separately and access derived
 * in the same query: every open item, and the newest `INBOX_HISTORY_PAGE`
 * closed ones about a task they read now. A closed item about a task they
 * cannot read is not returned at all, and takes no place in the page, so the
 * history leaves no gap that would count it. The recipient is the only person
 * whose items come back: the query names them, and the attention row it joins
 * is theirs by its foreign key. Oldest raised first.
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
  const rows = await tx.query<ItemRow>(ITEMS, [
    ...(await reach(tx, recipientPersonId)),
    INBOX_HISTORY_PAGE,
  ]);
  return rows.map((row) => itemOf(row));
}

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
