// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72 on the conversation path (ops-astro-roadmap
// `docs/decisions/execution.md`, 28 September and 13 October 2026): the
// person's words are judged by source, as a task run's are. The broker finds
// the source from the conversation's rows, never the caller's claim.
//
// A conversation is the owner's own work when its person holds the business's
// active owner role, every person turn in it is theirs and was written while
// they held it (a turn typed as a client's contact stays one), and it is on no
// task or on a task that is the owner's own (`broker-sources.ts`). Only then do the
// owner's words, the earlier turns and the page pointer count as
// business-internal free text, which the owner's subscription may carry, and
// only when each value is bound to the conversation's rows. A conversation on
// a client's task is client work: no subscription carries it.

import { isUuid, type TenantQuery } from '../../core-records/src/index.ts';
import { ownersOwn } from './broker-sources.ts';
import { readPage } from './broker-task.ts';
import type { ConversationCallRequest } from './broker-conversation-types.ts';
import type { ClaimedField, ResolvedField } from './broker-types.ts';

export interface ConversationSource {
  readonly ownerWork: boolean;
  readonly clientWork: boolean;
}

const NOBODYS: ConversationSource = { ownerWork: false, clientWork: false };

const READ_CONVERSATION = `select c.scope_record_id::text as page,
         c.body_purged_at is null as kept,
         exists (
           select 1 from public.memberships m
            where m.business_id = c.business_id and m.person_id = c.owner_person_id
              and m.active and m.ended_at is null and m.role_key = 'owner') as owner,
         not exists (
           select 1 from public.conversation_messages cm
            where cm.business_id = c.business_id and cm.conversation_id = c.id
              and cm.role = 'person' and cm.author_actor_id <> c.owner_actor_id) as own_turns,
         not exists (
           select 1 from public.conversation_messages cm
             join public.actors a on a.business_id = cm.business_id and a.id = cm.author_actor_id
            where cm.business_id = c.business_id and cm.conversation_id = c.id
              and cm.role = 'person'
              and not exists (
                select 1 from public.memberships m
                 where m.business_id = a.business_id and m.person_id = a.person_id
                   and m.role_key = 'owner' and m.joined_at <= cm.created_at
                   and (m.ended_at is null or m.ended_at > cm.created_at))) as written_as_owner,
         (select m.body from public.conversation_messages m
           where m.business_id = c.business_id and m.conversation_id = c.id and m.id = $3
             and m.role = 'person' and m.author_actor_id = c.owner_actor_id) as asked
    from public.conversations c where c.business_id = $1 and c.id = $2`;

/** The earlier turns of the conversation, before the asked message, with these bodies. */
const READ_EARLIER = `select m.role, m.body from public.conversation_messages m
    join public.conversation_messages a
      on a.business_id = m.business_id and a.conversation_id = m.conversation_id and a.id = $3
   where m.business_id = $1 and m.conversation_id = $2 and m.created_at < a.created_at
     and m.role in ('person', 'agent') and m.body = any($4::text[])`;

interface Turn {
  readonly role: string;
  readonly body: string;
}

/**
 * The earlier turns, only when the value is exactly their canonical JSON: an
 * array of `{ role, body }` and nothing else, so no byte rides along unbound
 * (an extra property, a duplicated key, other spacing).
 */
function turnsOf(value: string): readonly Turn[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const turns = parsed.map((turn: unknown) => {
      const { role, body } = (typeof turn === 'object' && turn !== null ? turn : {}) as Turn;
      return { role, body };
    });
    const typed = turns.every(
      (turn) => typeof turn.role === 'string' && typeof turn.body === 'string',
    );
    return typed && JSON.stringify(turns) === value ? turns : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page pointer names the conversation's own task and a prefix of its
 * title, and is exactly their canonical JSON, so no byte rides along unbound.
 */
function namesPage(value: string, pageId: string, title: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const { task, title: named } = parsed as Record<string, unknown>;
    return (
      task === pageId &&
      typeof named === 'string' &&
      title.startsWith(named) &&
      JSON.stringify({ task, title: named }) === value
    );
  } catch {
    return false;
  }
}

/** Every earlier turn supplied is one of this conversation's, before the asked message. */
async function earlierBound(
  tx: TenantQuery,
  request: ConversationCallRequest,
  value: string,
): Promise<boolean> {
  const turns = turnsOf(value);
  if (turns === undefined) return false;
  const found = await tx.query<Turn>(READ_EARLIER, [
    tx.businessId,
    request.conversation.id,
    request.messageId,
    turns.map((turn) => turn.body),
  ]);
  return turns.every((turn) =>
    found.some((row) => row.role === turn.role && row.body === turn.body),
  );
}

/**
 * The conversation's source, from its rows; one this business does not hold is
 * nobody's own. Owner work needs every supplied value bound to those rows: the
 * message is the asked message's stored body, the page names the
 * conversation's own task, and each earlier turn is one of its own.
 */
export async function conversationSource(
  tx: TenantQuery,
  request: ConversationCallRequest,
): Promise<ConversationSource> {
  const { messageId } = request;
  const asked = messageId === undefined || !isUuid(messageId) ? null : messageId;
  const [found] = await tx.query<{
    readonly page: string | null;
    readonly kept: boolean;
    readonly owner: boolean;
    readonly own_turns: boolean;
    readonly written_as_owner: boolean;
    readonly asked: string | null;
  }>(READ_CONVERSATION, [tx.businessId, request.conversation.id, asked]);
  if (found === undefined) return NOBODYS;
  const page = found.page === null ? undefined : await readPage(tx, found.page);
  if (found.page !== null && page === undefined) return NOBODYS;
  const clientWork = page !== undefined && page.clientId !== null;
  const title = page?.source.data['title'];
  const bound = async (field: ClaimedField): Promise<boolean> => {
    switch (field.name) {
      case 'message':
        return found.asked !== null && field.value === found.asked;
      case 'page':
        return found.page !== null && namesPage(field.value, found.page, String(title ?? ''));
      case 'earlier':
        return asked !== null && (await earlierBound(tx, request, field.value));
      default:
        return false;
    }
  };
  let allBound = true;
  for (const field of request.fields) {
    // In turn: the transaction answers one statement at a time.
    // eslint-disable-next-line no-await-in-loop
    if (!(await bound(field))) allBound = false;
  }
  const pageOwn = page === undefined || ownersOwn(page.source);
  const ownerWork =
    found.kept &&
    found.owner &&
    found.own_turns &&
    found.written_as_owner &&
    allBound &&
    pageOwn &&
    !clientWork;
  return { ownerWork, clientWork };
}

/**
 * The fields as the broker acts on them. A claim only narrows (S3): in the
 * owner's own conversation a claim of `outside` or `business_internal` is the
 * owner's own free text; a claim of a client's or a guest's source stays one.
 * Anywhere else every claim of `business_internal` counts as `outside`.
 */
export function judgedFields(
  fields: readonly ClaimedField[],
  source: ConversationSource,
): readonly ResolvedField[] {
  return fields.map((field) => {
    const ours = field.source === 'business_internal' || field.source === 'outside';
    if (source.ownerWork && ours) {
      return { name: field.name, source: 'business_internal', value: field.value, ownerWork: true };
    }
    const claimed = field.source === 'business_internal' ? 'outside' : field.source;
    return { name: field.name, source: claimed, value: field.value };
  });
}
