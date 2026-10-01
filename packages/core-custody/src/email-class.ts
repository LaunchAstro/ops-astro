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

import type { InboxReason, TenantQuery } from '../../core-records/src/index.ts';

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
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `aw07b:${byPerson ? 'person' : 'client'}:${tx.businessId}:${id}`,
  ]);
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
