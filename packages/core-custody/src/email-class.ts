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
// relationship email a week per client. Each window's read takes a
// transaction-scoped advisory lock on its own key first and is written in the
// same transaction, so two senders racing for one person or one client
// queue, and the second reads the first's `asked`. An attempt that failed
// with proof nothing went does not spend a window.

import {
  advisoryLock,
  hasRoom,
  type InboxReason,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';

export type MailClass = 'staff' | 'transactional' | 'relationship';

/**
 * Failures that prove the provider took nothing: custody never reached it.
 * Any answer from the provider, a redirect or an error status included, may
 * have sent, so it is never followed by a second send (the broker's rule),
 * and it spends its window.
 */
export const NOTHING_SENT: ReadonlySet<string> = new Set([
  'refused',
  'unlisted',
  'bad_path',
  'forbidden',
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
          and a.observed_at > now() - make_interval(secs => $3::double precision / 1000)
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
 * outcome's commit after the call ended. Custody ends every dispatch by the
 * operation's `timeoutMs` (one abort signal over the lookup, the request and
 * the answer), so an ask older than both was answered or its sender died.
 * Either way the provider holds no call of it open, and the ceiling bounds
 * provider calls. The attempt itself stays `asked`: unknown, never sent
 * again (`mayStillSend`), and still spending its day and its client's week.
 */
export const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * Emails in flight for this business: asks younger than the bound whose item's
 * last email observation is still `asked`. One email is one provider call: a
 * daily batch's asks share their person and their transaction's `now()`, so
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
                  and a.observed_at > now() - make_interval(secs => $2::double precision / 1000)
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
