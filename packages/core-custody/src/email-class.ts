// SPDX-License-Identifier: AGPL-3.0-only
//
// Which kind of mail an inbox email is, and the windows it is counted in
// (AW-07b, owner answers 10 and 20, CS-16.9).
//
// Every client send carries its class. An item owed to a client (a client
// comment) is `transactional` when a person wrote the comment: a person's act
// caused it, so it is outside the weekly cap and keeps the daily batch. It is
// `relationship` when an agent or a worker wrote it, or when no author is
// found: automation's mail to a client, at most one a week per client across
// every source. Mail to staff is `staff` and carries no client class.
//
// The class and the timing are written on the attempt's `asked` observation
// as its evidence (`batch:daily`, `class:<class>`), so the windows are read
// from the attempts themselves: one daily email per person and one
// relationship email a week per client. Both ends of a window are clock
// readings: an ask is observed when it is reserved (`recordAsked`), and a
// window is read against the clock when the read runs, never a
// transaction's start. Each window's read takes a
// transaction-scoped advisory lock on its own key first and is written in the
// same transaction, so two senders racing for one person or one client
// queue, and the second reads the first's `asked`. An attempt that failed
// with proof nothing went does not spend a window.

import {
  advisoryLock,
  hasRoom,
  recordDeliveryAttempt,
  taskAccess,
  type InboxReason,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';

export type MailClass = 'staff' | 'transactional' | 'relationship';

/**
 * Failures that prove the provider took nothing: custody never reached it,
 * or the send never asked custody because its ask had lapsed (`expired`).
 * Any answer from the provider, a redirect or an error status included, may
 * have sent, so it is never followed by a second send (the broker's rule),
 * and it spends its window.
 */
export const NOTHING_SENT: ReadonlySet<string> = new Set([
  'refused',
  'unlisted',
  'bad_path',
  'forbidden',
  'expired',
]);

export const DAY_MS: number = 24 * 60 * 60 * 1000;
export const WEEK_MS: number = 7 * DAY_MS;

/** The mail's class, read from the item and, for a client comment, who wrote it. */
export async function classOf(
  tx: TenantQuery,
  item: { readonly reason: InboxReason; readonly factKind: string; readonly factId: string },
): Promise<MailClass> {
  if (item.reason !== 'client_comment') return 'staff';
  const [author] = await tx.query<{ readonly kind: string }>(
    `select a.kind from public.records c
       join public.actors a on a.business_id = c.business_id and a.id::text = c.data ->> 'author'
      where c.business_id = $1 and c.id = $2 and $3 = 'record'`,
    [tx.businessId, item.factId, item.factKind],
  );
  return author?.kind === 'person' ? 'transactional' : 'relationship';
}

/** What an `asked` observation carries: the batch marker and the client class, or nothing. */
export function askedEvidence(daily: boolean, mailClass: MailClass): string | undefined {
  const parts = [daily ? 'batch:daily' : '', mailClass === 'staff' ? '' : `class:${mailClass}`];
  const evidence = parts.filter((part) => part !== '').join(' ');
  return evidence === '' ? undefined : evidence;
}

/** One item that passed every check: whose it is, where it goes, and its class. */
export interface CheckedItem {
  readonly itemId: string;
  readonly reason: InboxReason;
  readonly recipient: string;
  readonly subject: string;
  readonly to: string;
  /** The task's client, which the weekly cap counts by; null for a task of no client. */
  readonly client: string | null;
  readonly mailClass: MailClass;
}

/**
 * The items whose recipient can still read their task, judged again after every lock the send
 * waits on and just before `asked` is written: access lost while the email was prepared withholds
 * the items it reaches, however early they were checked.
 */
export async function stillReadable(
  tx: TenantQuery,
  items: readonly CheckedItem[],
): Promise<CheckedItem[]> {
  const kept: CheckedItem[] = [];
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop
    if ((await taskAccess(tx, item.recipient, item.subject)) === 'readable') kept.push(item);
  }
  return kept;
}

/** Both host clocks at one moment: the monotonic one, and the wall clock, which counts suspend. */
export interface Reading {
  readonly monotonic: number;
  readonly wall: number;
}

export const readClocks = (): Reading => ({ monotonic: performance.now(), wall: Date.now() });

/**
 * Record `asked` on each item the email covers, with the batch marker and class it carries. Each
 * is observed at one instant, the reservation's own (`clock_timestamp()`), not the transaction's
 * start: the windows and the ceiling count from when the email was reserved, however long it took
 * to prepare, and a batch's asks share it, so they count as one email. Answers the host's clocks
 * read just before that instant, which the fence on the send counts from (`lapsed`).
 */
export async function recordAsked(
  tx: TenantQuery,
  items: readonly CheckedItem[],
  daily: boolean,
): Promise<Reading> {
  const reading = readClocks();
  const [reserved] = await tx.query<{ readonly at: string }>(
    'select clock_timestamp()::text as at',
  );
  for (const item of items) {
    const evidence = askedEvidence(daily, item.mailClass);
    // oxlint-disable-next-line no-await-in-loop
    await recordDeliveryAttempt(tx, {
      itemId: item.itemId,
      channel: 'email',
      state: 'asked',
      ...(evidence === undefined ? {} : { evidence }),
      ...(reserved === undefined ? {} : { observedAt: reserved.at }),
    });
  }
  return reading;
}

/**
 * Whether a window is spent: one person's daily email, or one client's
 * weekly relationship email. Takes the window's lock first, so the caller's
 * `asked`, written in this transaction, is what the next sender reads.
 */
export async function windowSpent(
  tx: TenantQuery,
  key: { readonly person: string } | { readonly client: string },
  windowMs: number,
): Promise<boolean> {
  const byPerson = 'person' in key;
  const id = byPerson ? key.person : key.client;
  await advisoryLock(tx, `aw07b:${byPerson ? 'person' : 'client'}:${tx.businessId}:${id}`);
  const [row] = await tx.query<{ readonly spent: boolean }>(
    `select exists (
       select 1 from public.inbox_delivery_attempts a
         join public.inbox_items i on i.business_id = a.business_id and i.id = a.item_id
         join public.records r on r.business_id = i.business_id and r.id = i.subject_record_id
        where a.business_id = $1 and a.channel = 'email' and a.state = 'asked'
          and a.observed_at > clock_timestamp() - make_interval(secs => $3::double precision / 1000)
          and case when $4 then i.recipient_person_id = $2::uuid and a.evidence like 'batch:daily%'
                   else r.uuid_7 = $2::uuid and a.evidence like '%class:relationship' end
          and not exists (
            select 1 from public.inbox_delivery_attempts f
             where f.business_id = a.business_id and f.item_id = a.item_id
               and f.channel = 'email' and f.observed_seq > a.observed_seq
               and f.state = 'failed' and f.evidence = any($5::text[]))
     ) as spent`,
    [tx.businessId, id, windowMs, byPerson, [...NOTHING_SENT]],
  );
  return row?.spent === true;
}

/**
 * How long past custody's own timeout an ask may still be a live send: the
 * start of its call, and the outcome's commit after the call ended. Custody
 * ends every dispatch by the operation's `timeoutMs` (one abort signal over
 * the lookup, the request and the answer), and a send starts its call within
 * the grace of its reservation or never (`lapsed`), so an ask older than both
 * was answered, its sender died, or it never reached the provider. In each
 * case the provider holds no call of it open, and the ceiling bounds provider
 * calls. An attempt with no outcome stays `asked`: unknown, never sent again
 * (`mayStillSend`), and still spending its day and its client's week.
 */
export const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * Kept off the grace by the fence, not added to the ceiling's bound: the fence and the ceiling
 * read different clocks, and a call starts a moment after its check, so a fence at the grace
 * itself could let a resumed send overlap its replacement by that moment.
 */
const FENCE_MARGIN_MS = 10_000;

/**
 * The fence on an ask whose sender paused: whether more than the grace, less a margin, has passed
 * since `reserved` (`recordAsked`'s reading, taken inside the ask's transaction just before its
 * instant) on either host clock. The monotonic clock does not count a suspended host and the wall
 * clock can step, while the ceiling ages an ask on the database's clock, so either one past the
 * fence lapses it. Checked just before custody is asked: an ask past it may already have stopped
 * counting, and a replacement may hold its place under the ceiling, so its sender records
 * `failed`, evidence `expired`, and never calls the provider. One within it starts a call that
 * custody ends while the ask still counts.
 */
export function lapsed(reserved: Reading): boolean {
  const now = readClocks();
  const fence = IN_FLIGHT_GRACE_MS - FENCE_MARGIN_MS;
  return now.monotonic - reserved.monotonic > fence || now.wall - reserved.wall > fence;
}

/**
 * Emails in flight for this business: asks younger than the bound whose item's
 * last email observation is still `asked`. One email is one provider call: a
 * daily batch's asks share their person and their reservation's instant, so
 * they count once; an email sent at once covers one item.
 */
function emailsInFlight(boundMs: number): (tx: TenantQuery) => Promise<number> {
  return async (tx) => {
    const [flight] = await tx.query<{ readonly n: number }>(
      `select count(distinct case when last.evidence like 'batch:daily%'
                                  then 'batch:' || last.recipient || ':' || last.observed_at::text
                                  else 'item:' || last.item_id::text end)::int as n
         from (select distinct on (a.item_id) a.item_id, a.state, a.evidence, a.observed_at,
                      i.recipient_person_id::text as recipient
                 from public.inbox_delivery_attempts a
                 join public.inbox_items i on i.business_id = a.business_id and i.id = a.item_id
                where a.business_id = $1 and a.channel = 'email'
                  and a.observed_at > clock_timestamp() - make_interval(secs => $2::double precision / 1000)
                order by a.item_id, a.observed_seq desc) last
        where last.state = 'asked'`,
      [tx.businessId, boundMs],
    );
    return flight?.n ?? 0;
  };
}

/**
 * The catalogued concurrency, as a durable limit: an ask counts until its
 * outcome is kept, or until custody's timeout and the grace have passed.
 * Checked under the limit's lock just before `asked` is written, so a refusal
 * writes nothing.
 */
export type Room = () => Promise<boolean>;

export function roomFor(tx: TenantQuery, operation: ModelOperation): Room {
  const limit = {
    name: `email:${operation.key}`,
    limit: operation.concurrency,
    count: emailsInFlight(operation.timeoutMs + IN_FLIGHT_GRACE_MS),
  };
  return async () => await hasRoom(tx, [limit]);
}

/** The item's last email observation allows a send: none yet, or a failure that proves nothing went. */
export async function mayStillSend(tx: TenantQuery, itemId: string): Promise<boolean> {
  const [last] = await tx.query<{ readonly state: string; readonly evidence: string | null }>(
    `select state, evidence from public.inbox_delivery_attempts
      where business_id = $1 and item_id = $2 and channel = 'email'
      order by observed_seq desc limit 1`,
    [tx.businessId, itemId],
  );
  return last === undefined || (last.state === 'failed' && NOTHING_SENT.has(last.evidence ?? ''));
}

/** What a delivery refuses before any item is asked. */
export type DeliverRefusal = 'OPERATION_NOT_CATALOGUED' | 'SENDER_NOT_VERIFIED';

/** RFC 5322's dot-atom in ASCII: a from's local part, never a display name, space or line break. */
const DOT_ATOM = /^[\w!#$%&'*+/=?^`{|}~-]+(?:\.[\w!#$%&'*+/=?^`{|}~-]+)*$/u;
/** Printable ASCII: a domain that lower-cases to the verified subdomain only if it already is one. */
const ASCII = /^[!-~]+$/u;
/** RFC 5321's limits in octets; both checks above take ASCII only, so a character is one octet. */
const MAX_LOCAL_OCTETS = 64;
const MAX_ADDRESS_OCTETS = 254;

/**
 * The report vouches for one subdomain: mail from anything but one bare address on it, within
 * RFC 5321's lengths, is not verified, and only a report that says it is not from the fake
 * source (`mock`) counts.
 */
export function fromVerifiedSender(
  from: string,
  sender: { readonly verified: boolean; readonly subdomain: string; readonly mock: boolean },
): boolean {
  const [local = '', domain = '', ...rest] = from.split('@');
  return (
    sender.verified &&
    sender.mock === false &&
    DOT_ATOM.test(local) &&
    local.length <= MAX_LOCAL_OCTETS &&
    from.length <= MAX_ADDRESS_OCTETS &&
    rest.length === 0 &&
    ASCII.test(domain) &&
    domain.toLowerCase() === sender.subdomain.toLowerCase()
  );
}
