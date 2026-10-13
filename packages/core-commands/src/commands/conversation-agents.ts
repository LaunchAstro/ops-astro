// SPDX-License-Identifier: AGPL-3.0-only
//
// The deployment's model agent (`CommandContext.carrier`, #1531) as a member of
// a person's conversation: it hears a call only from a conversation it is an
// open member of. The owner adds it by choosing a model it carries, at
// `conversation.start` or `conversation.set_model`; another model closes the
// membership, as a purge and a deactivation do in storage. Nothing joins, and
// nothing is refused, with no carrier, for a person it does not list, on a
// client's or an unseen task (until Nathan's product call), or when its agent
// is not active. The task's and agent's rows are read for share, so a client
// link or a deactivation running now commits first and is seen, or waits.

import { conversationModelsOf, OLLAMA_PROVIDER } from '../../../core-connectors/src/index.ts';
import { slotOf, TASK_SPINE, type TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { installProvider } from './conversation-model.ts';

const CLIENT = slotOf(TASK_SPINE, 'client');

/** The carrier carries Ollama, and only on an install whose conversations run on it. */
function carries(model: unknown): boolean {
  const provider = installProvider();
  if (provider !== OLLAMA_PROVIDER) return false;
  const models = conversationModelsOf(provider);
  return model === null ? models.length > 0 : models.some((one) => one.id === model);
}

/** The conversation is on no task, or on an internal task this session can see, held for share. */
async function internal(tx: TenantQuery, conversationId: string): Promise<boolean> {
  const [conversation] = await tx.query<{ readonly scope_record_id: string | null }>(
    `select scope_record_id from conversations where business_id = $1 and id = $2`,
    [tx.businessId, conversationId],
  );
  if (conversation === undefined) return false;
  if (conversation.scope_record_id === null) return true;
  const [task] = await tx.query<{ readonly client_id: string | null }>(
    `select ${CLIENT}::text as client_id from records
      where business_id = $1 and id = $2 and deleted_at is null
      for share`,
    [tx.businessId, conversation.scope_record_id],
  );
  return task !== undefined && task.client_id === null;
}

async function join(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
): Promise<void> {
  const { carrier, session } = context;
  if (carrier === undefined || !carrier.people.includes(session.personId)) return;
  if (!(await internal(tx, conversationId))) return;
  const agent = await tx.query(
    `select 1 from actors
      where business_id = $1 and id = $2 and kind = 'agent' and active
      for share`,
    [tx.businessId, carrier.agent],
  );
  if (agent.length === 0) return;
  await tx.query(
    `insert into conversation_agent_members
       (business_id, conversation_id, agent_actor_id, added_by_actor_id)
     values ($1, $2, $3, $4)
     on conflict (business_id, conversation_id, agent_actor_id) where left_at is null
     do nothing`,
    [tx.businessId, conversationId, carrier.agent, session.actorId],
  );
}

async function leave(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
): Promise<void> {
  if (context.carrier === undefined) return;
  const open = [tx.businessId, conversationId, context.carrier.agent];
  // Locked first, so the close is stamped after any wait on a call holding it.
  await tx.query(
    `select 1 from conversation_agent_members
      where business_id = $1 and conversation_id = $2 and agent_actor_id = $3 and left_at is null
      for update`,
    open,
  );
  await tx.query(
    `update conversation_agent_members set left_at = greatest(clock_timestamp(), joined_at)
      where business_id = $1 and conversation_id = $2 and agent_actor_id = $3 and left_at is null`,
    open,
  );
}

/**
 * The carrier's membership of the caller's own conversation, after its model
 * was kept (so `model` is an offered id, or null for the default): joined on a
 * model it carries, left on one it does not. Asked under the conversation's row lock, or on the row just
 * inserted, by `conversation.start` and `conversation.set_model`.
 */
export async function followModel(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
  model: unknown,
): Promise<void> {
  await (carries(model) ? join(tx, context, conversationId) : leave(tx, context, conversationId));
}
