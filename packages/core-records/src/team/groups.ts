// SPDX-License-Identifier: AGPL-3.0-only
//
// Group conversations (C71-G, CS-7.41), on C71-D's rows: a `team_conversation`
// record of kind `group` with its name and creator, its members in
// `team_conversation_members`, and its messages comments with audience `group`
// on the one comment record. No other table.
//
// **One conversation's writes take one lock.** Every message, read-marker
// move, member change and leave holds the conversation's lock first
// (`lockConversation`), and each reads the wall clock under it. A member's
// window is cut on a millisecond boundary nothing else in the conversation
// shares: the change reads the clock, then waits out that millisecond before it
// commits. A message stamped before the change is at or before the boundary,
// and one stamped after it is past it, so a member removed reads nothing
// written after, and a member added reads nothing written before.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';
import { lockConversation, type ConversationTypes } from './conversations.ts';

/** The longest group name, after trimming. */
export const GROUP_NAME_LIMIT = 80;

/** The name a person meant: trimmed, 1 to 80 characters, no control character. */
export function groupNameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
  if (name.length === 0 || name.length > GROUP_NAME_LIMIT || /[\u0000-\u001F\u007F]/u.test(name)) {
    return undefined;
  }
  return name;
}

/** Start a group: its record and every member's row, the creator's first. */
export async function startGroup(
  tx: TenantQuery,
  types: ConversationTypes,
  creator: string,
  name: string,
  teammates: readonly string[],
): Promise<string> {
  const id = randomUUID();
  await lockConversation(tx, id);
  await tx.query(
    `insert into public.records (business_id, id, record_type_id, data)
     values ($1, $2, $3, jsonb_build_object(
       'chat_kind', 'group', 'chat_name', $4::text, 'chat_creator', $5::text))`,
    [tx.businessId, id, types.conversationTypeId, name, creator],
  );
  await tx.query(
    `insert into public.team_conversation_members (business_id, conversation_id, person_id, joined_at)
     select $1, $2, person, date_trunc('milliseconds', clock_timestamp())
       from unnest($3::uuid[]) as person`,
    [tx.businessId, id, [creator, ...teammates]],
  );
  return id;
}

export interface GroupMembership {
  readonly creator: string;
  /** Every current member's person id. */
  readonly members: readonly string[];
}

/**
 * A group the person is a current member of, with its lock held until the
 * transaction ends; undefined for anything else, which is every other
 * person's conversation, every direct one and every other business's.
 */
export async function lockOwnGroup(
  tx: TenantQuery,
  types: ConversationTypes,
  conversationId: string,
  personId: string,
): Promise<GroupMembership | undefined> {
  if (!isUuid(conversationId)) return undefined;
  await lockConversation(tx, conversationId);
  const rows = await tx.query<{ readonly creator: string; readonly members: readonly string[] }>(
    `select r.uuid_1::text as creator,
            array(select o.person_id::text from public.team_conversation_members o
                   where o.business_id = r.business_id and o.conversation_id = r.id
                     and o.left_at is null) as members
       from public.records r
       join public.team_conversation_members m
         on m.business_id = r.business_id and m.conversation_id = r.id
        and m.person_id = $4 and m.left_at is null
      where r.business_id = $1 and r.id = $2 and r.record_type_id = $3
        and r.deleted_at is null and r.txt_1 = 'group'`,
    [tx.businessId, conversationId, types.conversationTypeId, personId],
  );
  return rows[0];
}

export async function renameGroup(
  tx: TenantQuery,
  conversationId: string,
  name: string,
): Promise<void> {
  await tx.query(
    `update public.records set data = data || jsonb_build_object('chat_name', $3::text)
      where business_id = $1 and id = $2`,
    [tx.businessId, conversationId, name],
  );
}

/**
 * The boundary a member change is cut on: the wall clock's millisecond, held
 * past before this returns, so no message in this conversation shares it.
 */
async function boundary(tx: TenantQuery): Promise<string> {
  const rows = await tx.query<{ readonly at: string }>(
    `select to_char(date_trunc('milliseconds', clock_timestamp()) at time zone 'utc',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, pg_sleep(0.002)`,
  );
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('boundary: the clock answered no row');
  return at;
}

/**
 * Add, re-add and remove members under the conversation's held lock. An added
 * member reads from just after the boundary; a re-added one from there too,
 * their earlier window and marker gone. A removed member's window ends at it.
 */
export async function changeGroupMembers(
  tx: TenantQuery,
  conversationId: string,
  change: { readonly add: readonly string[]; readonly remove: readonly string[] },
): Promise<void> {
  const at = await boundary(tx);
  if (change.add.length > 0) {
    await tx.query(
      `insert into public.team_conversation_members
         (business_id, conversation_id, person_id, joined_at)
       select $1, $2, person, $4::timestamptz + interval '1 millisecond'
         from unnest($3::uuid[]) as person
       on conflict (business_id, conversation_id, person_id) do update
         set joined_at = excluded.joined_at, left_at = null, last_read_at = null`,
      [tx.businessId, conversationId, change.add, at],
    );
  }
  if (change.remove.length > 0) {
    await tx.query(
      `update public.team_conversation_members set left_at = $4::timestamptz
        where business_id = $1 and conversation_id = $2 and person_id = any($3::uuid[])
          and left_at is null`,
      [tx.businessId, conversationId, change.remove, at],
    );
  }
}

/** Whether every one of these people is staff here (`isStaff`, one query). */
export async function allStaff(tx: TenantQuery, people: readonly string[]): Promise<boolean> {
  if (!people.every((person) => isUuid(person))) return false;
  const rows = await tx.query<{ readonly n: string }>(
    `select count(distinct person_id)::text as n from public.memberships
      where business_id = $1 and person_id = any($2::uuid[]) and active
        and role_key in ('owner', 'admin', 'member')`,
    [tx.businessId, people],
  );
  return Number(rows[0]?.n) === new Set(people).size;
}
