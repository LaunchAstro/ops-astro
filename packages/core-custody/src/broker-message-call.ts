// SPDX-License-Identifier: AGPL-3.0-only
//
// One model call per conversation message (#1531): a retry of a message is
// answered from the call it already has, and the row is started at most once,
// with its carriers row on a carried deployment. Its settled answer is copied
// until the reply is kept (#1563). Apart from `broker-conversation.ts` to keep
// it under the line limit.

import { randomUUID } from 'node:crypto';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import type { TenantQuery, TransactionQuery } from '../../core-records/src/index.ts';
import { writeCarriers } from './broker-carriage.ts';
import type { ConversationCallRequest } from './broker-conversation-types.ts';
import { registerPromptCopy } from './broker-reserve.ts';
import type { BrokerRoute, Carrier, ModelCallResult } from './broker-types.ts';

/**
 * The message's call, if one was made: a retry is answered from it, never a
 * second call (#1531). A kept reply is found before the broker is asked. A
 * call still with the model, or settled with its reply kept or being kept, is
 * on its way; any other ending kept nothing. A settled call whose keep failed
 * has its answer copied (`copyAnswer`), which the caller keeps as the reply.
 */
export async function messageCall(
  tx: TenantQuery,
  messageId: string | undefined,
): Promise<ModelCallResult | undefined> {
  if (messageId === undefined) return undefined;
  const [call] = await tx.query<{
    readonly id: string;
    readonly conversation_id: string;
    readonly state: string;
    readonly recent: boolean;
  }>(
    `select id, conversation_id, state,
            ended_at > clock_timestamp() - interval '30 seconds' as recent
       from public.model_calls
      where business_id = $1 and conversation_message_id = $2`,
    [tx.businessId, messageId],
  );
  if (call === undefined) return undefined;
  const answering =
    call.state === 'dispatched' ||
    (call.state === 'settled' &&
      (call.recent || (await replyLanded(tx, call.conversation_id, messageId))));
  return { ok: false, code: answering ? 'STILL_ANSWERING' : 'ANSWER_ENDED', callId: call.id };
}

/**
 * A settled call's reply, kept now or by a keep queued on the conversation:
 * its row is taken as the keep takes it, so a keep waiting there commits
 * first, and the reply is read after the wait. A keep in its first 30 s may
 * not have asked for the row yet; `messageCall` counts those as on their way.
 */
async function replyLanded(
  tx: TenantQuery,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  await tx.query(
    `select 1 from public.conversations where business_id = $1 and id = $2 for update`,
    [tx.businessId, conversationId],
  );
  const kept = await tx.query(
    `select 1 from public.conversation_messages
      where business_id = $1 and conversation_id = $2 and answers_message_id = $3`,
    [tx.businessId, conversationId, messageId],
  );
  return kept.length > 0;
}

/**
 * The row, started: nothing held, the conversation and its message, no task
 * fact. A message that has a call already gets none (the unique index decides
 * a race), and undefined comes back. A carried deployment's call is written
 * with its carriers row, naming the agent.
 */
export async function insertStarted(
  tx: TenantQuery,
  request: ConversationCallRequest,
  operation: ModelOperation,
  route: BrokerRoute,
  account: string | null,
  carrier: Carrier | undefined,
): Promise<string | undefined> {
  const callId = randomUUID();
  const inserted = await tx.query(
    `insert into public.model_calls
       (business_id, id, conversation_id, conversation_message_id, operation_key, state,
        reserved_minor, route_key, route_reach, credential_kind, provider, credential_ref, account,
        started_at)
     values ($1, $2, $3, $4, $5, 'dispatched', 0, $6, $7, $8, $9, $10, $11, clock_timestamp())
     on conflict (business_id, conversation_message_id) where conversation_message_id is not null
     do nothing
     returning id`,
    [
      tx.businessId,
      callId,
      request.conversation.id,
      request.messageId ?? null,
      operation.key,
      route.key,
      route.reach,
      route.credentialKind,
      route.provider,
      route.credentialRef,
      account,
    ],
  );
  if (inserted.length === 0) return undefined;
  await registerPromptCopy(tx, callId);
  if (carrier !== undefined) await writeCarriers(tx, callId, carrier);
  return callId;
}

/** Words a message's row can hold (0092), so a reply may be kept from them. */
const ANSWER_LIMIT = 20_000;
/** Half a split character: with the `u` flag only an unpaired surrogate matches. */
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const copyable = (text: string): boolean =>
  text.trim() !== '' &&
  text.length <= ANSWER_LIMIT &&
  !text.includes('\0') &&
  !UNPAIRED_SURROGATE.test(text);

/**
 * A settled call's answer, copied in its settling transaction (#1563): a
 * retry of the message keeps its reply from the copy, never from a second
 * call. Registered first, as every copy is (0085); invalidated when the
 * reply is kept, and deleted with the body when it is purged. The
 * conversation's row is held for its key after the call's, and its body read
 * after that wait: a body a purge took first is not copied into, and the
 * settlement stands. The message's row is never taken (20261013010000). The
 * copy is a savepoint of its own, and text no reply could hold is not copied.
 */
export async function copyAnswer(
  tx: TransactionQuery,
  callId: string,
  text: string,
): Promise<void> {
  if (!copyable(text)) return;
  const [call] = await tx.query<{ readonly conversation: string; readonly message: string }>(
    `select c.conversation_id as conversation, c.conversation_message_id as message
       from public.model_calls c
       join public.conversations v on v.business_id = c.business_id and v.id = c.conversation_id
      where c.business_id = $1 and c.id = $2 and c.conversation_message_id is not null
        and v.body_purged_at is null
      for key share of v`,
    [tx.businessId, callId],
  );
  if (call === undefined) return;
  const { conversation, message } = call;
  await tx.savepoint(async (inner) => {
    await inner.query(
      `insert into public.copy_registrations
         (business_id, id, copy_class, copy_key, invalidation_trigger, retention_class)
       values ($1, $2, 'answer_copy', $3, 'reply_kept', 'transient')`,
      [inner.businessId, randomUUID(), `model_call:${callId}`],
    );
    await inner.query(
      `insert into public.conversation_answer_copies
         (business_id, call_id, conversation_id, message_id, body)
       values ($1, $2, $3, $4, $5)`,
      [inner.businessId, callId, conversation, message, text],
    );
  });
}
