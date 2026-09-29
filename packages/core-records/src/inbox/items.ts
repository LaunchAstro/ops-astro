// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox's three records (INB-1a): the recipient's item, their attention
// row and each delivery attempt, over `migrations/0032_inbox_items.sql`.
//
// An item is a pointer to a fact that is already durable somewhere else, so
// nothing here reads or writes the fact's content. The four axes come back side
// by side and are never folded into one: work state from the item, attention
// from the recipient's own row, delivery from the attempts, and access derived
// on this read from the recipient's live grants. Read is not done, delivered is
// not seen, and withheld is not gone.

import { effectiveGrants, type Scope, type Subject } from '../authority/grants.ts';
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

/**
 * Derived at every read, never stored. `withheld`: the task is there and the
 * recipient no longer holds read on it. `gone`: the task is trashed.
 */
export type InboxAccess = 'readable' | 'withheld' | 'gone';

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
  readonly closedByPersonId: string | null;
  readonly seenAt: Date | null;
  readonly lastDelivery: DeliveryState | null;
}

/**
 * The pointers come back only while the task is readable. A withheld or gone
 * item says that it is owed and why, and names neither the task nor the fact,
 * so an item on another client's task leaks no identifier of theirs.
 */
export type InboxItem =
  | (InboxItemAxes & Pointers & { readonly access: 'readable' })
  | (InboxItemAxes & { readonly access: 'withheld' | 'gone' });

interface Pointers {
  readonly subjectRecordId: string;
  readonly factId: string;
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

/** A row as read: the axes, the pointers, and the two facts access is derived from. */
type ItemRow = InboxItemAxes &
  Pointers & {
    readonly trashed: boolean;
    readonly clientId: string | null;
  };

/**
 * Every item of one recipient, each axis read separately, access derived now.
 * The recipient is the only person whose items come back: the query names them,
 * and the attention row it joins is theirs by its foreign key.
 */
export async function readInboxItems(
  tx: TenantQuery,
  recipientPersonId: string,
): Promise<readonly InboxItem[]> {
  const rows = await tx.query<ItemRow>(
    `select i.id, i.recipient_person_id as "recipientPersonId",
            i.subject_record_id as "subjectRecordId", i.reason, i.fact_kind as "factKind",
            i.fact_id as "factId", i.owed, i.work_state as "workState", i.raised_at as "raisedAt",
            i.closed_at as "closedAt", i.closed_by_person_id as "closedByPersonId",
            a.seen_at as "seenAt",
            (select d.state from public.inbox_delivery_attempts d
              where d.business_id = i.business_id and d.item_id = i.id
              order by d.observed_seq desc limit 1) as "lastDelivery",
            r.deleted_at is not null as trashed, r.uuid_7 as "clientId"
       from public.inbox_items i
       join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
       left join public.inbox_attention a on a.business_id = i.business_id and a.item_id = i.id
      where i.business_id = $1 and i.recipient_person_id = $2
      order by i.raised_at, i.id`,
    [tx.businessId, recipientPersonId],
  );
  const subjects = await recipientSubjects(tx, recipientPersonId);
  const items: InboxItem[] = [];
  for (const { trashed, clientId, subjectRecordId, factId, ...axes } of rows) {
    // oxlint-disable-next-line no-await-in-loop
    const access = await accessOf(tx, subjects, subjectRecordId, trashed, clientId);
    items.push(
      access === 'readable' ? { ...axes, access, subjectRecordId, factId } : { ...axes, access },
    );
  }
  return items;
}

/** The person and their own acting identities: the two a grant may name. */
async function recipientSubjects(tx: TenantQuery, personId: string): Promise<readonly Subject[]> {
  const actors = await tx.query<{ readonly id: string }>(
    `select id from public.actors
      where business_id = $1 and person_id = $2 and kind = 'person' and active`,
    [tx.businessId, personId],
  );
  return [
    { kind: 'person', id: personId },
    ...actors.map((actor): Subject => ({ kind: 'actor', id: actor.id })),
  ];
}

/**
 * Read on the task through the one effective-grant walk: a business grant, a
 * grant on this task, or a party grant on the task's own client. A party grant
 * on another client reaches nothing here, which is the client separation.
 */
async function accessOf(
  tx: TenantQuery,
  subjects: readonly Subject[],
  taskId: string,
  trashed: boolean,
  clientId: string | null,
): Promise<InboxAccess> {
  if (trashed) return 'gone';
  const scopes: Scope[] = [{ kind: 'record', id: taskId }];
  if (clientId !== null) scopes.push({ kind: 'party', id: clientId });
  for (const scope of scopes) {
    // oxlint-disable-next-line no-await-in-loop
    const grants = await effectiveGrants(tx, subjects, {
      collection: 'task',
      action: 'read',
      scope,
    });
    if (grants.length > 0) return 'readable';
  }
  return 'withheld';
}
