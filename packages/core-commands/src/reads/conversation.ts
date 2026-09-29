// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's conversation at three detail levels, one statement each, for the
// agent bundles (MP-4-5, CS-15.19; the bundles themselves are API-4's).
//
// - brief: the counts and the last message;
// - standard: the counts and the recent messages (the last twenty);
// - full: the counts and the whole thread.
//
// Messages come oldest first. The caller has already authorised the task, as
// `task.read` does before it reads comments; this reads nothing but that
// task's live comments, filtered by business and comment type in the query.
//
// **Inside and outside.** A reader inside the business gets every comment,
// both counts and each stored field. A reader outside gets the client
// messages alone, no internal count, and each message in the fields the
// catalogue marks `shared`, joined from the field definitions in the same
// statement: the allowlist `externalCommentProjection` applies to `task.read`,
// so a field nobody classified stays in the database here too.

import type { TenantQuery } from '../../../core-records/src/index.ts';

export type ConversationLevel = 'brief' | 'standard' | 'full';

/** How many messages the standard level carries. */
export const STANDARD_MESSAGES = 20;

const LIMIT: Readonly<Record<ConversationLevel, number | null>> = {
  brief: 1,
  standard: STANDARD_MESSAGES,
  full: null,
};

type Message = Readonly<Record<string, unknown>>;

export interface ConversationRead {
  readonly level: ConversationLevel;
  readonly counts: Readonly<Partial<Record<'internal' | 'client', number>>>;
  /** Brief only: the latest message, or null on an empty thread. */
  readonly last?: Message | null;
  /** Standard and full: the messages, oldest first. */
  readonly messages?: readonly Message[];
}

const STATEMENT = `
  with thread as (
    select r.id, r.data from public.records r
     where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
       and r.data ->> 'task' = $3 and ($4 or r.data ->> 'audience' = 'client')),
  recent as (
    select id, data from thread
     order by data ->> 'posted_at' desc, id desc
     limit $5)
  select
    (select count(*) from thread where data ->> 'audience' = 'internal')::int as internal,
    (select count(*) from thread where data ->> 'audience' = 'client')::int as client,
    coalesce((select jsonb_agg(
        jsonb_build_object('id', recent.id) || case when $4 then recent.data - 'task'
          else coalesce((select jsonb_object_agg(f.key, recent.data -> f.key)
                           from public.field_defs f
                          where f.business_id = $1 and f.record_type_id = $2
                            and f.visibility_class = 'shared' and f.deactivated_at is null
                            and recent.data ? f.key), '{}'::jsonb) end
        order by recent.data ->> 'posted_at', recent.id) from recent), '[]'::jsonb) as messages`;

export async function readConversation(
  tx: TenantQuery,
  commentTypeId: string | undefined,
  taskId: string,
  level: ConversationLevel,
  internal: boolean,
): Promise<ConversationRead> {
  const rows =
    commentTypeId === undefined
      ? []
      : await tx.query<{
          readonly internal: number;
          readonly client: number;
          readonly messages: readonly Message[];
        }>(STATEMENT, [tx.businessId, commentTypeId, taskId, internal, LIMIT[level]]);
  const row = rows[0] ?? { internal: 0, client: 0, messages: [] };
  const counts = internal ? { internal: row.internal, client: row.client } : { client: row.client };
  if (level === 'brief') return { level, counts, last: row.messages.at(-1) ?? null };
  return { level, counts, messages: row.messages };
}
