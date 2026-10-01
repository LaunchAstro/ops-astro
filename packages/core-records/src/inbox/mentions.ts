// SPDX-License-Identifier: AGPL-3.0-only
//
// Raising on a comment (INB-1b): who a comment names, and the mention each
// staff member it names is raised in the comment's own transaction. Moved
// from `raise.ts` unchanged.

import type { TenantQuery } from '../tenancy/database.ts';
import { REACH, taskAccess } from './access.ts';
import { raiseInboxItem, type InboxReason } from './items.ts';

/** A person a comment names, as this business knows them. */
export interface Mentioned {
  readonly personId: string;
  /** Their name here, or the identifier as sent when no such person is here. */
  readonly label: string;
  readonly readable: boolean;
  /** Staff, as opposed to an outside party with no membership. */
  readonly member: boolean;
  /**
   * An outside party entitled to CS-16.8's client comment: a stored
   * entitlement on the client's party, never a login. This head stores none,
   * so `readMentions` answers false until the party model lands.
   */
  readonly paidClient: boolean;
}

/**
 * Who a comment names, and whether each can read it: the task, and for a
 * team-only comment a membership too, since an outside party never reads one.
 * A person of another business is not found here and is named back only by
 * the identifier the caller sent. An identifier matches in any letter case, as
 * the database compares it, and a found person comes back by their stored one.
 */
export async function readMentions(
  tx: TenantQuery,
  comment: { readonly taskId: string; readonly audience: string },
  personIds: readonly string[],
): Promise<readonly Mentioned[]> {
  const people = await tx.query<{ readonly id: string; name: string; member: boolean }>(
    `select p.id, p.display_name as name,
            exists (select 1 from public.memberships m
                     where m.business_id = p.business_id and m.person_id = p.id and m.active)
              as member
       from public.people p where p.business_id = $1 and p.id = any($2::uuid[])`,
    [tx.businessId, personIds],
  );
  const named: Mentioned[] = [];
  const asked = new Map(personIds.map((sent) => [sent.toLowerCase(), sent] as const));
  for (const [canonical, sent] of asked) {
    const person = people.find((row) => row.id.toLowerCase() === canonical);
    const readable =
      person !== undefined &&
      (person.member || comment.audience === 'client') &&
      // oxlint-disable-next-line no-await-in-loop
      (await taskAccess(tx, person.id, comment.taskId)) === 'readable';
    named.push({
      personId: person?.id ?? sent,
      label: person?.name ?? sent,
      readable,
      member: person?.member ?? false,
      paidClient: false,
    });
  }
  return named;
}

/**
 * Which of these people an author could already see, so a refusal may name
 * them: staff, or a person holding read on a client the author reads (a
 * business-wide reader reads every client). Anyone else is named back only by
 * the identifier as sent, so a commenter cannot learn another client's names.
 */
export async function seenBy(
  tx: TenantQuery,
  authorActorId: string,
  personIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const author = await tx.query<{ readonly personId: string | null }>(
    `select person_id as "personId" from public.actors where business_id = $1 and id = $2`,
    [tx.businessId, authorActorId],
  );
  const rows = await tx.query<{ readonly id: string }>(
    `${REACH}
     select p.id from public.people p
      where p.business_id = $1 and p.id = any($3::uuid[])
        and ((select business from reach)
             or exists (select 1 from public.memberships m
                         where m.business_id = p.business_id and m.person_id = p.id and m.active)
             or exists (select 1 from effective e
                         where e.collection = 'task' and e.action = 'read'
                           and e.scope_kind = 'party'
                           and e.scope_id = any((select parties from reach)::uuid[])
                           and ((e.subject_kind = 'person' and e.subject_id = p.id)
                                or (e.subject_kind = 'actor' and e.subject_id in (
                                      select a.id from public.actors a
                                       where a.business_id = p.business_id and a.person_id = p.id
                                         and a.kind = 'person' and a.active)))))`,
    [tx.businessId, author[0]?.personId ?? null, personIds],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * A comment saved: each staff member it names is raised a mention, never the
 * comment's own author. CS-16.8's client comment is owed only to a paid
 * client (`Mentioned.paidClient`, a stored entitlement on the client's party,
 * not a login): an outside party named in a client-visible comment they can
 * read is raised one when they are a paid client, and nothing otherwise.
 */
export async function raiseMentions(
  tx: TenantQuery,
  comment: {
    readonly taskId: string;
    readonly commentId: string;
    readonly authorActorId: string;
    readonly audience: string;
  },
  named: readonly Mentioned[],
): Promise<void> {
  const authors = await tx.query<{ readonly person_id: string | null }>(
    'select person_id from public.actors where business_id = $1 and id = $2',
    [tx.businessId, comment.authorActorId],
  );
  const author = authors[0]?.person_id ?? null;
  for (const person of named) {
    const reason = mentionReason(person, comment.audience);
    if (person.personId === author || reason === undefined) continue;
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person.personId,
      subjectRecordId: comment.taskId,
      reason,
      fact: { kind: 'record', id: comment.commentId },
    });
  }
}

/** Staff are owed a mention; a paid client reading a client-visible comment, a client comment. */
function mentionReason(person: Mentioned, audience: string): InboxReason | undefined {
  if (person.member) return 'mention';
  if (person.paidClient && person.readable && audience === 'client') return 'client_comment';
  return undefined;
}
