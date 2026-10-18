// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's own clock (#935 m2), read under its lock (`lockConversation`).

/**
 * The conversation's now, to the millisecond: the wall clock, held at or past
 * its newest message, its members' boundaries and the millisecond of every read
 * marker, so a clock that steps back never stamps a message behind any member's
 * marker (a message in a marker's millisecond ranks after those it counted),
 * never inside a window a member's change has closed, and never cuts a member
 * change before a message already written. Each argument is an SQL expression: the business id,
 * the conversation id, and the message record type's id.
 */
export function conversationClock(
  business: string,
  conversation: string,
  messageType: string,
): string {
  return `greatest(date_trunc('milliseconds', clock_timestamp()),
    (select max(c.ts_1) from public.records c
      where c.business_id = ${business} and c.record_type_id = ${messageType}
        and c.uuid_4 = ${conversation} and c.deleted_at is null),
    (select max(greatest(w.joined_at, w.left_at + interval '1 millisecond',
                         date_trunc('milliseconds', w.last_read_at)))
       from public.team_conversation_members w
      where w.business_id = ${business} and w.conversation_id = ${conversation}))`;
}

/** The message record type's id in business `business`, as an SQL expression. */
export const messageTypeOf = (business: string): string =>
  `(select id from public.record_types where business_id = ${business} and key = 'task_comment')`;
