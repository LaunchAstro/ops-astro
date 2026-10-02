// SPDX-License-Identifier: AGPL-3.0-only
//
// Who is in a conversation now (C71, CS-7.42), for what tells a person of
// one: the live channel admits a conversation's topic to its current members
// alone, the board stream says a conversation moved to them alone, and a
// mention in it is readable by them alone. Membership is the filter inside
// each query, as every conversation read asks it (`conversations.ts`).

import type { TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';
import type { Mentioned } from '../inbox/mentions.ts';

/**
 * Which of these live conversations `personId` is a current member of: joined
 * and not left. Another person's, another business's and a fabricated id are
 * all simply not in the answer.
 */
export async function currentConversations(
  tx: TenantQuery,
  conversationIds: readonly string[],
  personId: string,
): Promise<ReadonlySet<string>> {
  const ids = conversationIds.filter((id) => isUuid(id)).map((id) => id.toLowerCase());
  if (ids.length === 0) return new Set();
  const rows = await tx.query<{ readonly id: string }>(
    `select m.conversation_id::text as id
       from public.team_conversation_members m
       join public.records r on r.business_id = m.business_id and r.id = m.conversation_id
        and r.deleted_at is null
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        and t.key = 'team_conversation'
      where m.business_id = $1 and m.conversation_id = any($2::uuid[]) and m.person_id = $3
        and m.left_at is null`,
    [tx.businessId, ids, personId],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Who a message names, and whether each can read it: a current member of its
 * conversation, as `readMentions` asks a task comment's. A person of another
 * business is not found here and is named back only by the identifier sent.
 */
export async function readConversationMentions(
  tx: TenantQuery,
  conversationId: string,
  personIds: readonly string[],
): Promise<readonly Mentioned[]> {
  const people = await tx.query<{
    readonly id: string;
    readonly name: string;
    readonly member: boolean;
    readonly inside: boolean;
  }>(
    `select p.id, p.display_name as name,
            exists (select 1 from public.memberships m
                     where m.business_id = p.business_id and m.person_id = p.id and m.active)
              as member,
            exists (select 1 from public.team_conversation_members c
                     where c.business_id = p.business_id and c.conversation_id = $3
                       and c.person_id = p.id and c.left_at is null) as inside
       from public.people p where p.business_id = $1 and p.id = any($2::uuid[])`,
    [tx.businessId, personIds, conversationId],
  );
  const asked = new Map(personIds.map((sent) => [sent.toLowerCase(), sent] as const));
  return [...asked].map(([canonical, sent]) => {
    const person = people.find((row) => row.id.toLowerCase() === canonical);
    return {
      personId: person?.id ?? sent,
      label: person?.name ?? sent,
      readable: person !== undefined && person.member && person.inside,
      member: person?.member ?? false,
      paidClient: false,
    };
  });
}
