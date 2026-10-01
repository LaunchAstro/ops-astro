// SPDX-License-Identifier: AGPL-3.0-only
//
// A verified delivery or bounce event lands (AW-07b hook signature). System
// work, no person grant: the hook's signature is its authority, and the only
// thing it may move is the email attempt whose provider message id it names.
//
// The event is looked for in each of the deployment's businesses in turn, as
// the other system work does, by the `provider:<id>` evidence the send
// recorded on `accepted`. In the business that holds it, the item is locked
// (`for update`, the lock the send takes), and under that lock a replayed
// event id is refused and the attempt's last observation is read:
//
// - `email.delivered` moves an accepted attempt to `delivered`;
// - `email.bounced` moves it to `failed`, evidence `bounced`, and a bounced
//   attempt is never sent again (it is not a failure that proves nothing went);
// - `email.sent` moves nothing: accepted is already known, and delivered is
//   never shown when only sent is;
// - anything else, an open or a click among them, is ignored: an email open
//   never sets seen.
//
// Nothing here reaches the item's work state, its attention row or a gate:
// the only write is one `inbox_delivery_attempts` row (`AW-07b no decision`).

import {
  recordDeliveryAttempt,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { EmailHookEvent } from '../../core-connectors/src/index.ts';

export type EmailHookOutcome =
  'DELIVERED' | 'BOUNCED' | 'UNCHANGED' | 'IGNORED' | 'REPLAYED' | 'UNKNOWN_MESSAGE';

const MOVES: Readonly<
  Record<string, { readonly state: 'delivered' | 'failed'; readonly kind: string }>
> = {
  'email.delivered': { state: 'delivered', kind: 'delivered' },
  'email.bounced': { state: 'failed', kind: 'bounced' },
};
const KNOWN_UNMOVED: ReadonlySet<string> = new Set(['email.sent']);

/** In one business: the event's attempt moved, refused or not found (undefined). */
async function landIn(
  tx: TenantQuery,
  event: EmailHookEvent,
): Promise<EmailHookOutcome | undefined> {
  const [sent] = await tx.query<{ readonly item: string }>(
    `select item_id as item from public.inbox_delivery_attempts
      where business_id = $1 and channel = 'email' and state = 'accepted' and evidence = $2
      limit 1`,
    [tx.businessId, `provider:${event.messageId}`],
  );
  if (sent === undefined) return undefined;
  await tx.query('select 1 from public.inbox_items where business_id = $1 and id = $2 for update', [
    tx.businessId,
    sent.item,
  ]);
  const replayed = await tx.query(
    `select 1 from public.inbox_delivery_attempts
      where business_id = $1 and item_id = $2 and evidence = any($3::text[])`,
    [tx.businessId, sent.item, Object.values(MOVES).map((move) => `${move.kind}:${event.id}`)],
  );
  if (replayed.length > 0) return 'REPLAYED';
  const move = MOVES[event.type];
  if (move === undefined) return KNOWN_UNMOVED.has(event.type) ? 'UNCHANGED' : 'IGNORED';
  const [last] = await tx.query<{ readonly state: string }>(
    `select state from public.inbox_delivery_attempts
      where business_id = $1 and item_id = $2 and channel = 'email'
      order by observed_seq desc limit 1`,
    [tx.businessId, sent.item],
  );
  if (last?.state !== 'accepted') return 'UNCHANGED';
  await recordDeliveryAttempt(tx, {
    itemId: sent.item,
    channel: 'email',
    state: move.state,
    evidence: `${move.kind}:${event.id}`,
  });
  return move.state === 'delivered' ? 'DELIVERED' : 'BOUNCED';
}

/** Stub (tests first): nothing lands. */
export async function landEmailEvent(
  database: Database,
  businesses: readonly BusinessId[],
  event: EmailHookEvent,
): Promise<EmailHookOutcome> {
  void [database, businesses, event, landIn];
  return await Promise.resolve('IGNORED');
}
