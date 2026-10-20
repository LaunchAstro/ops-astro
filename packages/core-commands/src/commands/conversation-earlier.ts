// SPDX-License-Identifier: AGPL-3.0-only
//
// The earlier messages an exchange sends (`conversation-context.ts`): the
// last ten of the current context epoch before the asked one, each person's
// with its answer, oldest first, under `EARLIER_LIMIT` characters and the GPT
// runner's request bytes, and none at or after the history cut (#1666).

import { LOCAL_GPT_BODY_LIMIT, localGptAdapter } from '../../../core-connectors/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { Asked } from './conversation-owner.ts';

export const EARLIER_COUNT = 10;
export const EARLIER_LIMIT = 8_000;

/** Whether the whole GPT request, as the adapter writes it, fits the runner's body limit. */
const fits = (fields: Readonly<Record<string, string>>): boolean =>
  Buffer.byteLength(localGptAdapter(fields).body) <= LOCAL_GPT_BODY_LIMIT;

/** The last ten earlier messages as JSON, oldest dropped until it fits both bounds. */
export function earlierOf(
  rows: readonly { readonly role: string; readonly body: string }[],
  around: Readonly<Record<string, string>>,
): string {
  let kept = rows.slice(-EARLIER_COUNT).map(({ role, body }) => ({ role, body }));
  let text = JSON.stringify(kept);
  while (kept.length > 0 && (text.length > EARLIER_LIMIT || !fits({ ...around, earlier: text }))) {
    kept = kept.slice(1);
    text = JSON.stringify(kept);
  }
  return kept.length === 0 ? '' : text;
}

/**
 * The last earlier messages before the asked one, each person's with its
 * answer, oldest first; only those of the conversation's current context
 * epoch, which a purge of the task it was opened on bumps under the row lock
 * every message write takes. A reply counts only when its question does too,
 * so one kept after the purge to a question from before it is cut with it.
 */
interface EarlierRow {
  readonly role: string;
  readonly body: string;
  readonly author: string;
}

/**
 * The earlier messages, or undefined when the session does not own the
 * conversation (#1483). The owner is asked in the statement that reads the
 * messages, and one statement reads one snapshot, so the owner cannot change
 * between the check and the read; an owner changed first is refused. No row
 * lock: the exchange reads this before it locks the conversation, so a read
 * never waits behind a message write, a model pick or a purge.
 */
export async function earlierRows(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  cut: string | null,
): Promise<readonly EarlierRow[] | undefined> {
  const rows = await tx.query<{
    readonly role: string | null;
    readonly body: string;
    readonly author: string;
  }>(
    `select role, body, author from (
       select 1 as owned from conversations c
         join conversation_messages a on a.business_id = c.business_id and a.conversation_id = c.id
        where c.business_id = $1 and c.id = $2 and a.id = $3
          and c.owner_actor_id = $6 and c.body_purged_at is null) owner
     left join lateral (
       select m.role, m.body, m.created_at, m.id, m.author_actor_id::text as author
         from conversation_messages m
         join conversation_messages a
           on a.business_id = m.business_id and a.conversation_id = m.conversation_id
         join conversations c on c.business_id = m.business_id and c.id = m.conversation_id
         left join conversation_messages q
           on q.business_id = m.business_id and q.id = m.answers_message_id
        where m.business_id = $1 and m.conversation_id = $2 and a.id = $3
          and m.role in ('person', 'agent') and m.created_at < a.created_at
          and m.context_epoch = c.context_epoch
          and coalesce(q.context_epoch, m.context_epoch) = c.context_epoch
          and ($5::uuid is null or (m.created_at, m.id) < (
            select x.created_at, x.id from conversation_messages x
             where x.business_id = m.business_id and x.id = $5))
          and (m.role = 'agent' or exists (
            select 1 from conversation_messages r
             where r.business_id = m.business_id and r.conversation_id = m.conversation_id
               and r.answers_message_id = m.id))
        order by m.created_at desc, m.id desc
        limit $4) last on true
      order by last.created_at, last.id`,
    [tx.businessId, asked.conversationId, asked.messageId, EARLIER_COUNT, cut, session.actorId],
  );
  if (rows.length === 0) return undefined;
  return rows.flatMap(({ role, body, author }) => (role === null ? [] : [{ role, body, author }]));
}
