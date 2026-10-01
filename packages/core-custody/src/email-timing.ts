// SPDX-License-Identifier: AGPL-3.0-only
//
// When an inbox item is emailed (AW-07b, owner answer 10, CS-16.9). The
// delivery worker calls one of two entries and the send itself is the
// broker's (`broker-email.ts`):
//
// - `emailAtOnce`, for one item: a decision or an incident always, one email
//   per item, whatever the person chose; any other item only when its
//   recipient chose `instant` for its category.
// - `emailDailyBatch`, for one person: every other open, owed item they have
//   not seen and chose to hear about in the daily batch, in at most one email
//   a day. Several items link the inbox; a single item links itself.
//
// The person's choice per category (instant, daily batch, off) is MP-2-11's
// setting (CS-2.17), read here through `EmailPreferences` and never written.
// That setting is not on this branch, so every caller hands in a source, and
// the one tests use is made up (its `mock` is true). A choice silences email
// only: it never removes, clears or hides an item, and in-app stays on.
//
// Relationship mail to a client takes the client's one email a week; the
// batch drops an item whose client's week is spent and the item stands. Who
// was batched today, and which client was mailed this week, are read from the
// attempts under a lock on their key (`email-class.ts`).

import {
  toldAtOnce,
  type BusinessId,
  type Database,
  type InboxReason,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { Broker } from './broker-types.ts';
import {
  askOne,
  checkItem,
  deliver,
  emailResult,
  recordAsked,
  type Asked,
  type CheckedItem,
  type EmailResult,
  type MailSettings,
  type Room,
} from './broker-email.ts';
import { DAY_MS, WEEK_MS, windowSpent } from './email-class.ts';

export type EmailChoice = 'instant' | 'daily_batch' | 'off';

/** MP-2-11's per-person, per-category email choice, read only. */
export interface EmailPreferences {
  /** True while the source is made up: MP-2-11's setting has not landed here. */
  readonly mock: boolean;
  choice(tx: TenantQuery, personId: string, reason: InboxReason): Promise<EmailChoice>;
}

export interface EmailTiming {
  readonly broker: Broker;
  readonly mail: MailSettings;
  readonly preferences: EmailPreferences;
  /** The batch window, a day unless staging shortens it. */
  readonly dayMs?: number;
}

export type BatchResult =
  | { readonly ok: true; readonly items: number; readonly attemptIds: readonly string[] }
  | {
      readonly ok: false;
      readonly code:
        'NOTHING_WAITING' | 'BATCH_ALREADY_SENT' | 'EMAIL_AT_CEILING' | 'OPERATION_NOT_CATALOGUED';
    }
  | { readonly ok: false; readonly code: 'EMAIL_FAILED'; readonly fault: string };

/** One item now: a decision or an incident always, anything else only on `instant`. */
export async function emailAtOnce(
  database: Database,
  businessId: BusinessId,
  itemId: string,
  timing: EmailTiming,
): Promise<EmailResult | { readonly ok: false; readonly code: 'NOT_AT_ONCE' }> {
  const sent = await deliver(database, businessId, timing.broker, timing.mail, async (tx, room) => {
    const [item] = await tx.query<{ readonly recipient: string; readonly reason: InboxReason }>(
      `select recipient_person_id as recipient, reason from public.inbox_items
        where business_id = $1 and id = $2 and work_state = 'open'`,
      [tx.businessId, itemId],
    );
    if (item === undefined) return 'ITEM_NOT_OPEN';
    if (
      !toldAtOnce(item.reason) &&
      (await timing.preferences.choice(tx, item.recipient, item.reason)) !== 'instant'
    ) {
      return 'NOT_AT_ONCE';
    }
    return await askOne(tx, itemId, room);
  });
  return emailResult(sent);
}

/** The person's items for today's email: open, owed, not told at once, chosen for the batch. */
async function batchable(
  tx: TenantQuery,
  personId: string,
  preferences: EmailPreferences,
): Promise<CheckedItem[]> {
  const rows = await tx.query<{ readonly id: string; readonly reason: InboxReason }>(
    `select id, reason from public.inbox_items
      where business_id = $1 and recipient_person_id = $2 and work_state = 'open' and owed
      order by raised_at, id`,
    [tx.businessId, personId],
  );
  const kept: CheckedItem[] = [];
  for (const row of rows) {
    if (toldAtOnce(row.reason)) continue;
    // oxlint-disable-next-line no-await-in-loop
    if ((await preferences.choice(tx, personId, row.reason)) !== 'daily_batch') continue;
    // oxlint-disable-next-line no-await-in-loop
    const item = await checkItem(tx, row.id);
    if (typeof item !== 'string') kept.push(item);
  }
  return kept;
}

/** Drop relationship items whose client's week is spent; each client's lock in a fixed order. */
async function withinCap(tx: TenantQuery, items: readonly CheckedItem[]): Promise<CheckedItem[]> {
  const clients = [
    ...new Set(
      items.flatMap((item) =>
        item.mailClass === 'relationship' && item.client !== null ? [item.client] : [],
      ),
    ),
  ].toSorted();
  const spent = new Set<string>();
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop
    if (await windowSpent(tx, { client }, WEEK_MS)) spent.add(client);
  }
  return items.filter(
    (item) => item.mailClass !== 'relationship' || item.client === null || !spent.has(item.client),
  );
}

/** At most one email a day for one person, covering every item waiting for it. */
export async function emailDailyBatch(
  database: Database,
  businessId: BusinessId,
  personId: string,
  timing: EmailTiming,
): Promise<BatchResult> {
  const ask = async (
    tx: TenantQuery,
    room: Room,
  ): Promise<Asked | 'NOTHING_WAITING' | 'BATCH_ALREADY_SENT' | 'EMAIL_AT_CEILING'> => {
    if (await windowSpent(tx, { person: personId }, timing.dayMs ?? DAY_MS)) {
      return 'BATCH_ALREADY_SENT';
    }
    const items = await withinCap(tx, await batchable(tx, personId, timing.preferences));
    const [first] = items;
    if (first === undefined) return 'NOTHING_WAITING';
    if (!(await room())) return 'EMAIL_AT_CEILING';
    await recordAsked(tx, items, true);
    return {
      itemIds: items.map((item) => item.itemId),
      to: first.to,
      link: items.length === 1 ? first.itemId : null,
    };
  };
  const sent = await deliver(database, businessId, timing.broker, timing.mail, ask);
  if (!sent.ok) return sent;
  if (sent.state === 'failed') return { ok: false, code: 'EMAIL_FAILED', fault: sent.evidence };
  return { ok: true, items: sent.attemptIds.length, attemptIds: sent.attemptIds };
}
