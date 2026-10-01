// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox's three records (INB-1a): the recipient's item, their attention
// row and each delivery attempt, over `migrations/0042_inbox_items.sql`.
//
// An item is a pointer to a fact that is already durable somewhere else, so
// nothing here reads or writes the fact's content. The four axes come back side
// by side and are never folded into one: work state from the item, attention
// from the recipient's own row, delivery from the attempts, and access derived
// at each read from the recipient's live grants (`read.ts`). Read is not done,
// delivered is not seen, and withheld is not gone.

import { taskAccess } from './access.ts';
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

export interface InboxItemAxes {
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

export interface Disclosed {
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
 * Told at once on every channel it reaches, never batched or switched off:
 * a decision or an incident (owner answer 10, CS-16.9). The channel setting
 * refuses to quiet one and the email send never batches one.
 */
export function toldAtOnce(reason: InboxReason): boolean {
  return reason === 'decision' || reason === 'incident';
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
