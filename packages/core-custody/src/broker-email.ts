// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's email send (AW-07b): the only way a person is told by email
// that an inbox item waits. The delivery worker names an item, or a person
// for the daily batch (`email-timing.ts`), and nothing else; the recipient,
// their address and the link are read here, and the message leaves through
// custody under the catalogued `email.send`.
//
// 1. Check, in the item's business: the operation is catalogued and routed,
//    the item is open, its recipient can read its task now (so another
//    client's task is never mailed about), has not seen it in the app, has a
//    confirmed address, and no earlier email attempt on the item might have
//    gone out; relationship mail to a client also needs the client's week
//    unspent (`email-class.ts`). A refusal writes nothing and sends nothing.
//    Then each item the email covers is recorded `asked`, with its class.
// 2. Send, through custody, a request the adapter built from the declared
//    fields. The body carries one address, the item's or the inbox's, and
//    never a decision.
// 3. Record what came back as each item's next observation: `accepted`
//    with the provider's message id, or `failed` with the fault's kind. No
//    answer body, address or link is kept, returned or written anywhere.
//
// Nothing here reads a provider answer as an instruction, and no path from
// an answer reaches the item's work state or any gate: an attempt never
// moves the item (`recordDeliveryAttempt`).

import {
  hasRoom,
  recordDeliveryAttempt,
  taskAccess,
  type BusinessId,
  type Database,
  type InboxReason,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import type { Broker, BrokerRoute, ProviderAdapter } from './broker-types.ts';
import type { CustodyOutcome } from './custody.ts';
import {
  askedEvidence,
  classOf,
  NOTHING_SENT,
  WEEK_MS,
  windowSpent,
  type MailClass,
} from './email-class.ts';

/** The catalogued name the send dispatches by. */
export const EMAIL_OPERATION = 'email.send';

/** Where the installation's own pages are, and who its mail is from. */
export interface MailSettings {
  readonly appOrigin: string;
  readonly from: string;
}

export type EmailRefusal =
  | 'OPERATION_NOT_CATALOGUED'
  | 'ITEM_NOT_OPEN'
  | 'ITEM_WITHHELD'
  | 'ITEM_SEEN'
  | 'NO_ADDRESS'
  | 'EMAIL_MAY_HAVE_GONE'
  | 'CLIENT_CAP_SPENT'
  | 'EMAIL_AT_CEILING';

export type EmailResult =
  | { readonly ok: true; readonly attemptId: string; readonly state: 'accepted' }
  | { readonly ok: false; readonly code: EmailRefusal }
  | {
      readonly ok: false;
      readonly code: 'EMAIL_FAILED';
      readonly attemptId: string;
      readonly fault: string;
    };

/** Emails in flight for this business: items whose last email observation is still `asked`. */
async function emailsInFlight(tx: TenantQuery): Promise<number> {
  const [flight] = await tx.query<{ readonly n: number }>(
    `select count(*)::int as n from (
       select distinct on (item_id) state from public.inbox_delivery_attempts
        where business_id = $1 and channel = 'email'
        order by item_id, observed_seq desc) last
      where state = 'asked'`,
    [tx.businessId],
  );
  return flight?.n ?? 0;
}

/**
 * The catalogued concurrency, as a durable limit: an ask counts until its
 * outcome is kept. Checked under the limit's lock just before `asked` is
 * written, so a refusal writes nothing.
 */
export type Room = () => Promise<boolean>;

function roomFor(tx: TenantQuery, operation: ModelOperation): Room {
  const limit = {
    name: `email:${operation.key}`,
    limit: operation.concurrency,
    count: emailsInFlight,
  };
  return async () => await hasRoom(tx, [limit]);
}

interface Routed {
  readonly operation: ModelOperation;
  readonly route: BrokerRoute;
  readonly adapter: ProviderAdapter;
}

function routed(broker: Broker): Routed | undefined {
  const operation = broker.operations.get(EMAIL_OPERATION);
  if (operation === undefined) return undefined;
  const route = broker.routes.find((entry) => entry.provider === operation.provider);
  const adapter = broker.providers.get(operation.provider);
  return route === undefined || adapter === undefined ? undefined : { operation, route, adapter };
}

/** The item's last email observation allows a send: none yet, or a failure that proves nothing went. */
async function mayStillSend(tx: TenantQuery, itemId: string): Promise<boolean> {
  const [last] = await tx.query<{ readonly state: string; readonly evidence: string | null }>(
    `select state, evidence from public.inbox_delivery_attempts
      where business_id = $1 and item_id = $2 and channel = 'email'
      order by observed_seq desc limit 1`,
    [tx.businessId, itemId],
  );
  return last === undefined || (last.state === 'failed' && NOTHING_SENT.has(last.evidence ?? ''));
}

/** One item that passed every check: whose it is, where it goes, and its class. */
export interface CheckedItem {
  readonly itemId: string;
  readonly reason: InboxReason;
  readonly to: string;
  /** The task's client, which the weekly cap counts by; null for a task of no client. */
  readonly client: string | null;
  readonly mailClass: MailClass;
}

/**
 * Every check on one item, in its business, locking it: open, its recipient
 * can read its task now (so another client's task is never mailed about),
 * they have not seen it in the app, they have a confirmed address, and no
 * earlier email attempt on it might have gone out. Writes nothing.
 */
export async function checkItem(
  tx: TenantQuery,
  itemId: string,
): Promise<CheckedItem | EmailRefusal> {
  const [item] = await tx.query<{
    readonly recipient: string;
    readonly subject: string;
    readonly reason: InboxReason;
    readonly factKind: string;
    readonly factId: string;
    readonly client: string | null;
    readonly seen: boolean;
  }>(
    `select i.recipient_person_id as recipient, i.subject_record_id as subject, i.reason,
            i.fact_kind as "factKind", i.fact_id as "factId", r.uuid_7 as client,
            exists (select 1 from public.inbox_attention a
                     where a.business_id = i.business_id and a.item_id = i.id) as seen
       from public.inbox_items i
       join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
      where i.business_id = $1 and i.id = $2 and i.work_state = 'open'
      for update of i`,
    [tx.businessId, itemId],
  );
  if (item === undefined) return 'ITEM_NOT_OPEN';
  if ((await taskAccess(tx, item.recipient, item.subject)) !== 'readable') return 'ITEM_WITHHELD';
  if (item.seen) return 'ITEM_SEEN';
  const [address] = await tx.query<{ readonly value: string }>(
    `select value from public.person_identifiers
      where business_id = $1 and person_id = $2 and kind = 'email' and review_state = 'confirmed'
      order by last_observed_at desc, id limit 1`,
    [tx.businessId, item.recipient],
  );
  if (address === undefined) return 'NO_ADDRESS';
  if (!(await mayStillSend(tx, itemId))) return 'EMAIL_MAY_HAVE_GONE';
  return {
    itemId,
    reason: item.reason,
    to: address.value,
    client: item.client,
    mailClass: await classOf(tx, item),
  };
}

/** Record `asked` on each item the email covers, with the batch marker and class it carries. */
export async function recordAsked(
  tx: TenantQuery,
  items: readonly CheckedItem[],
  daily: boolean,
): Promise<void> {
  for (const item of items) {
    const evidence = askedEvidence(daily, item.mailClass);
    // oxlint-disable-next-line no-await-in-loop
    await recordDeliveryAttempt(tx, {
      itemId: item.itemId,
      channel: 'email',
      state: 'asked',
      ...(evidence === undefined ? {} : { evidence }),
    });
  }
}

/** One item, sent on its own: every check, the client's weekly cap, the ceiling, then `asked`. */
export async function askOne(
  tx: TenantQuery,
  itemId: string,
  room: Room,
): Promise<Asked | EmailRefusal> {
  const item = await checkItem(tx, itemId);
  if (typeof item === 'string') return item;
  if (
    item.mailClass === 'relationship' &&
    item.client !== null &&
    (await windowSpent(tx, { client: item.client }, WEEK_MS))
  ) {
    return 'CLIENT_CAP_SPENT';
  }
  if (!(await room())) return 'EMAIL_AT_CEILING';
  await recordAsked(tx, [item], false);
  return { itemIds: [itemId], to: item.to, link: itemId };
}

/** What one email covers: its items, its recipient's address, and the item it links, or the inbox. */
export interface Asked {
  readonly itemIds: readonly string[];
  readonly to: string;
  readonly link: string | null;
}

/** Step 3's reading: the provider's message id, or the fault's kind. Never the answer's body. */
function observed(
  outcome: CustodyOutcome,
  operation: ModelOperation,
): { readonly state: 'accepted' | 'failed'; readonly evidence: string } {
  if (outcome.kind === 'refused') return { state: 'failed', evidence: 'refused' };
  if (outcome.kind === 'worker_lost') return { state: 'failed', evidence: 'worker_lost' };
  if (!outcome.outbound.ok) return { state: 'failed', evidence: outcome.outbound.fault };
  let body: unknown;
  try {
    body = JSON.parse(outcome.outbound.body);
  } catch {
    return { state: 'failed', evidence: 'malformed' };
  }
  const answer = operation.answer(body);
  if (answer === undefined) return { state: 'failed', evidence: 'malformed' };
  return { state: 'accepted', evidence: `provider:${answer.text}` };
}

export type Delivered<R extends string> =
  | { readonly ok: false; readonly code: R | 'OPERATION_NOT_CATALOGUED' }
  | {
      readonly ok: true;
      readonly state: 'accepted' | 'failed';
      readonly evidence: string;
      readonly attemptIds: readonly string[];
    };

/**
 * Steps 1 to 3 for one email: `ask` checks and records `asked` in one
 * transaction (or refuses, writing nothing), the message leaves through
 * custody, and what came back is recorded on every item the email covers.
 */
export async function deliver<R extends string>(
  database: Database,
  businessId: BusinessId,
  broker: Broker,
  mail: MailSettings,
  ask: (tx: TenantQuery, room: Room) => Promise<Asked | R>,
): Promise<Delivered<R>> {
  const found = routed(broker);
  if (found === undefined) return { ok: false, code: 'OPERATION_NOT_CATALOGUED' };
  const { operation, route, adapter } = found;
  const asked = await database.withBusiness(
    businessId,
    async (tx) => await ask(tx, roomFor(tx, operation)),
  );
  if (typeof asked === 'string') return { ok: false, code: asked };
  const path = asked.link === null ? '/inbox' : `/inbox/${encodeURIComponent(asked.link)}`;
  const address = new URL(path, mail.appOrigin).href;
  const built = adapter.build({ to: asked.to, from: mail.from, address });
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  const seen = observed(outcome, operation);
  const attemptIds = await database.withBusiness(businessId, async (tx) => {
    const ids: string[] = [];
    for (const itemId of asked.itemIds) {
      // oxlint-disable-next-line no-await-in-loop
      ids.push(await recordDeliveryAttempt(tx, { itemId, channel: 'email', ...seen }));
    }
    return ids;
  });
  return { ok: true, ...seen, attemptIds };
}

/** Tell an inbox item's recipient by email where to go, through the broker only. */
export async function sendInboxEmail(
  database: Database,
  businessId: BusinessId,
  itemId: string,
  broker: Broker,
  mail: MailSettings,
): Promise<EmailResult> {
  const sent = await deliver(
    database,
    businessId,
    broker,
    mail,
    async (tx, room) => await askOne(tx, itemId, room),
  );
  return emailResult(sent);
}

/** The one-item answer from a delivery. */
export function emailResult<R extends string>(
  sent: Delivered<R>,
): EmailResult | { readonly ok: false; readonly code: R | 'OPERATION_NOT_CATALOGUED' } {
  if (!sent.ok) return sent;
  const attemptId = sent.attemptIds[0] ?? '';
  if (sent.state === 'accepted') return { ok: true, attemptId, state: 'accepted' };
  return { ok: false, code: 'EMAIL_FAILED', attemptId, fault: sent.evidence };
}
