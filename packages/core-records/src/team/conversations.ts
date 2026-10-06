// SPDX-License-Identifier: AGPL-3.0-only
//
// Team conversations (C71-D; C71-G builds its groups on the same rows).
//
// A conversation is a record of its own type, `team_conversation`: its kind,
// a group's name, who started it and, for a direct conversation, the pair it
// is between. Its messages are comments on the one comment record
// (`tasks/comments.ts`), anchored by the comment's `conversation` field in
// place of a task, so no other table or store holds a message body (RA-12).
// Who is in it is `team_conversation_members` (20261006074341): each member from
// `joined_at` to `left_at`, with their own read marker.
//
// **Membership is the filter, inside every query.** A conversation is read,
// listed and counted only through the reader's own member row, so another
// person's conversation, or another business's, is not there to be answered.
// A member reads nothing written before they joined or after they left. The
// owner and administrators hold no way round it: a conversation is private to
// its members (CAPABILITY-SLICES, team chat's audience, 27 September 2026).

import { randomUUID } from 'node:crypto';
import { advisoryLock, type TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';
import type { SpineField } from '../tasks/spine.ts';
import { shownAt, type ReadPosition } from './read-position.ts';

/** The conversation type's key, beside `task_comment`. */
export const CONVERSATION_TYPE_KEY = 'team_conversation';

export type ConversationKind = 'direct' | 'group';

const SYSTEM = { writeMode: 'system', owningOperations: [], escalatingOperation: null } as const;

/**
 * Every field is the server's: the command that starts a conversation writes them. Prefixed,
 * because an installed system key is refused at the top level of every request body
 * (`prepare.ts`), and `name` there is a tag's and a client's.
 */
export const CONVERSATION_SPINE: readonly SpineField[] = [
  { key: 'chat_kind', label: 'Kind', valueType: 'text', slot: 'txt_1', ...SYSTEM },
  { key: 'chat_name', label: 'Name', valueType: 'text', slot: 'txt_2', ...SYSTEM },
  // The two person ids of a direct conversation, in order: the one per pair.
  { key: 'chat_pair', label: 'Pair', valueType: 'text', slot: 'txt_3', ...SYSTEM },
  { key: 'chat_creator', label: 'Started by', valueType: 'uuid', slot: 'uuid_1', ...SYSTEM },
];

/** The record type ids a conversation read needs, or undefined where either is not installed. */
export interface ConversationTypes {
  readonly conversationTypeId: string;
  readonly commentTypeId: string;
}

export async function readConversationTypes(
  tx: TenantQuery,
): Promise<ConversationTypes | undefined> {
  const rows = await tx.query<{ readonly key: string; readonly id: string }>(
    `select key, id from public.record_types
      where business_id = $1 and key in ('team_conversation', 'task_comment')`,
    [tx.businessId],
  );
  const conversationTypeId = rows.find((row) => row.key === CONVERSATION_TYPE_KEY)?.id;
  const commentTypeId = rows.find((row) => row.key === 'task_comment')?.id;
  return conversationTypeId === undefined || commentTypeId === undefined
    ? undefined
    : { conversationTypeId, commentTypeId };
}

/** The server's now, to the millisecond a comment's `posted_at` carries. */
const NOW_MS = `date_trunc('milliseconds', now())`;

/** The wall clock to the millisecond, read after the conversation's lock is held. */
const CLOCK_MS = `date_trunc('milliseconds', clock_timestamp())`;

/**
 * Serialise one conversation's message writes and read-marker moves until the
 * transaction ends. A message is stamped and placed (`created_at`, strictly
 * after the one before) and a marker set under this lock, so a message that
 * commits later is always placed after any marker moved before it, and never
 * hides behind one, even in the same millisecond. The key takes the id in
 * lower case, so every spelling of one conversation's id takes the same lock.
 */
export async function lockConversation(tx: TenantQuery, conversationId: string): Promise<void> {
  await advisoryLock(tx, `chat.conversation:${tx.businessId}:${conversationId.toLowerCase()}`);
}

/**
 * The one direct conversation between two people, found or started, with its lock held for
 * the message about to be written. A lock on the pair serialises two first messages.
 */
export async function directConversation(
  tx: TenantQuery,
  types: ConversationTypes,
  from: string,
  to: string,
): Promise<string> {
  const pair = [from, to].toSorted().join(':');
  await advisoryLock(tx, `chat.direct:${tx.businessId}:${pair}`);
  const found = await tx.query<{ readonly id: string }>(
    `select id from public.records
      where business_id = $1 and record_type_id = $2 and txt_3 = $3 and deleted_at is null`,
    [tx.businessId, types.conversationTypeId, pair],
  );
  if (found[0] !== undefined) {
    await lockConversation(tx, found[0].id);
    return found[0].id;
  }
  const id = randomUUID();
  await lockConversation(tx, id);
  await tx.query(
    `insert into public.records (business_id, id, record_type_id, data)
     values ($1, $2, $3, jsonb_build_object(
       'chat_kind', 'direct', 'chat_pair', $4::text, 'chat_creator', $5::text))`,
    [tx.businessId, id, types.conversationTypeId, pair, from],
  );
  await tx.query(
    `insert into public.team_conversation_members (business_id, conversation_id, person_id, joined_at)
     select $1, $2, person, ${NOW_MS} from unnest($3::uuid[]) as person`,
    [tx.businessId, id, [from, to]],
  );
  return id;
}

/**
 * A message's position, which a read marker is compared with: its millisecond (`ts_1`) plus, in
 * microseconds, its rank among that millisecond's live messages in write order (`created_at`,
 * `tasks/comments.ts`); no command trashes one, and none writes a thousand in one millisecond.
 */
const POSITION = `c.ts_1 + interval '1 microsecond' * (select count(*) from public.records s
   where s.business_id = c.business_id and s.record_type_id = c.record_type_id
     and s.uuid_4 = c.uuid_4 and s.ts_1 = c.ts_1 and s.deleted_at is null
     and (s.created_at, s.id) <= (c.created_at, c.id))`;

/**
 * Move a member's own read marker to `upTo`, never back and never past now; false when the
 * person is not a current member. A marker is a position: the millisecond plus how many of
 * its messages were seen; `now` has seen all, counted before the clock is read, and a read
 * position the ones its reading showed (never more than exist; only the first if past now).
 */
export async function moveReadMarker(
  tx: TenantQuery,
  conversationId: string,
  personId: string,
  upTo: ReadPosition | 'now',
): Promise<boolean> {
  await lockConversation(tx, conversationId);
  const [at, seen] = upTo === 'now' ? [null, 0] : [upTo.at.toISOString(), upTo.seen];
  const moved = await tx.query(
    `with mine as (
       select c.ts_1 from public.records c where c.business_id = $1 and c.uuid_4 = $2::uuid and c.deleted_at is null
          and c.record_type_id = (select id from public.record_types where business_id = $1 and key = 'task_comment')
     ), upto as (
       select coalesce(least(date_trunc('milliseconds', $4::timestamptz), ${CLOCK_MS}), (select max(ts_1) from mine)) as ms
     )
     update public.team_conversation_members
        set last_read_at = greatest(coalesce(last_read_at, '-infinity'), (
              select ms + interval '1 microsecond' * (select least(count(*), case when $4::timestamptz
                       is null then count(*) when upto.ms = date_trunc('milliseconds', $4::timestamptz)
                       then $5::int else 1 end) from mine where ts_1 = upto.ms)
                from upto), case when $4::timestamptz is null then ${CLOCK_MS} end)
      where business_id = $1 and conversation_id = $2 and person_id = $3 and left_at is null
      returning 1`,
    [tx.businessId, conversationId, personId, at, seen],
  );
  return moved.length > 0;
}

/** The messages a member may read: written while they were a member, and live. */
const MEMBER_READS = `
  c.business_id = m.business_id and c.record_type_id = $2 and c.uuid_4 = m.conversation_id
  and c.deleted_at is null and c.ts_1 >= m.joined_at
  and (m.left_at is null or c.ts_1 <= m.left_at)`;

export interface ConversationSummary {
  readonly conversationId: string;
  readonly kind: ConversationKind;
  /** A group's name; null on a direct conversation, and to a member who has left. */
  readonly name: string | null;
  /** Every current member's person id, the reader included; none to one who has left. */
  readonly members: readonly string[];
  readonly lastRead: string | null;
  readonly lastMessageAt: string | null;
  /** Others' messages after the reader's marker. */
  readonly unread: number;
}

/** The reader's conversations, newest message first, each with its unread derived now. */
export async function listConversations(
  tx: TenantQuery,
  types: ConversationTypes,
  personId: string,
): Promise<readonly ConversationSummary[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly kind: ConversationKind;
    readonly name: string | null;
    readonly members: readonly string[];
    readonly last_read_at: Date | null;
    readonly last_message_at: Date | null;
    readonly unread: string;
  }>(
    `select m.conversation_id as id, r.txt_1 as kind, m.last_read_at,
            case when m.left_at is null then r.txt_2 end as name,
            case when m.left_at is null then array(
              select o.person_id::text from public.team_conversation_members o
               where o.business_id = m.business_id and o.conversation_id = m.conversation_id
                 and o.left_at is null order by o.joined_at, o.person_id)
            else '{}' end as members,
            (select max(c.ts_1) from public.records c where ${MEMBER_READS}) as last_message_at,
            (select count(*) from public.records c
               join public.actors a on a.business_id = c.business_id and a.id = c.uuid_2
              where ${MEMBER_READS} and a.person_id is distinct from m.person_id
                and (m.last_read_at is null or ${POSITION} > m.last_read_at)) as unread
       from public.team_conversation_members m
       join public.records r on r.business_id = m.business_id and r.id = m.conversation_id
        and r.record_type_id = $3 and r.deleted_at is null
      where m.business_id = $1 and m.person_id = $4
      order by last_message_at desc nulls last, m.conversation_id`,
    [tx.businessId, types.commentTypeId, types.conversationTypeId, personId],
  );
  return rows.map((row) => ({
    conversationId: row.id,
    kind: row.kind,
    name: row.name,
    members: row.members,
    lastRead: row.last_read_at?.toISOString() ?? null,
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    unread: Number(row.unread),
  }));
}

export interface ConversationMessage {
  readonly id: string;
  /** The author's person id. */
  readonly authorId: string;
  readonly author: string;
  /** When it was written, as ISO text; tied messages carry a count (`shownAt`). */
  readonly at: string;
  readonly body: string;
}

/**
 * One conversation's messages, oldest first, and the reader's marker; or undefined when the
 * reader is not a member of it, which is every other person's conversation and business's.
 */
export async function readConversation(
  tx: TenantQuery,
  types: ConversationTypes,
  conversationId: string,
  personId: string,
): Promise<
  | { readonly lastRead: string | null; readonly messages: readonly ConversationMessage[] }
  | undefined
> {
  if (!isUuid(conversationId)) return undefined;
  const member = await tx.query<{ readonly last_read_at: Date | null }>(
    `select m.last_read_at from public.team_conversation_members m
       join public.records r on r.business_id = m.business_id and r.id = m.conversation_id
        and r.record_type_id = $3 and r.deleted_at is null
      where m.business_id = $1 and m.conversation_id = $2 and m.person_id = $4`,
    [tx.businessId, conversationId, types.conversationTypeId, personId],
  );
  if (member[0] === undefined) return undefined;
  const rows = await tx.query<{
    readonly id: string;
    readonly author_id: string;
    readonly author: string;
    readonly at: Date;
    readonly tied: string;
    readonly body: string;
  }>(
    `select c.id, p.id as author_id, p.display_name as author, c.ts_1 as at,
            count(*) over (partition by c.ts_1) as tied, c.data ->> 'body' as body
       from public.team_conversation_members m
       join public.records c on ${MEMBER_READS}
       join public.actors a on a.business_id = c.business_id and a.id = c.uuid_2
       join public.people p on p.business_id = a.business_id and p.id = a.person_id
      where m.business_id = $1 and m.conversation_id = $3 and m.person_id = $4
      order by c.ts_1, c.created_at, c.id`,
    [tx.businessId, types.commentTypeId, conversationId, personId],
  );
  return {
    lastRead: member[0].last_read_at?.toISOString() ?? null,
    messages: rows.map((row) => ({
      id: row.id,
      authorId: row.author_id,
      author: row.author,
      at: shownAt(row.at, Number(row.tied)),
      body: row.body,
    })),
  };
}
