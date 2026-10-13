// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { ConversationScope } from '../../packages/core-custody/src/index.ts';
import { createTask, type Schedules } from '../runtime/schedules-harness.ts';

export async function seedConversation(
  on: Schedules,
  id: string = randomUUID(),
): Promise<ConversationScope> {
  await on.db.app.withBusiness(on.business, async (tx) => {
    await tx.query(
      `insert into public.conversations
         (business_id, id, owner_actor_id, owner_person_id, title)
       values ($1, $2, $3, $4, 'Broker fixture')
       on conflict (business_id, id) do nothing`,
      [on.business, id, on.decider.actorId, on.decider.personId],
    );
  });
  return { id, businessId: on.business, ownerPersonId: on.decider.personId };
}

/** The world's person as the business's owner from now on: their membership ends and an owner's starts. */
export async function asOwner(on: Schedules): Promise<void> {
  await holding(on, 'owner');
}

/** The world's person holding `role` from now on, as the product changes a role. */
export async function holding(on: Schedules, role: 'owner' | 'member'): Promise<void> {
  await on.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [on.business, on.decider.personId],
  );
  await on.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [on.business, randomUUID(), on.decider.personId, role],
  );
}

/**
 * The owner's own question, stored as a person turn of a new conversation of
 * theirs, so the broker can bind the message to its row (owner line 72).
 */
export async function ownersQuestion(
  on: Schedules,
  message: string,
): Promise<{ readonly conversation: ConversationScope; readonly messageId: string }> {
  await asOwner(on);
  const conversation = await seedConversation(on);
  const messageId = randomUUID();
  await on.db.admin.execute(
    `insert into public.conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body)
     values ($1, $2, $3, 'person', $4, $5)`,
    [on.business, messageId, conversation.id, on.decider.actorId, message],
  );
  return { conversation, messageId };
}

/**
 * The owner's conversation on a task of theirs, with one earlier person turn
 * and the asked message stored, so the broker can bind the page, the earlier
 * turn and the message to their rows (owner line 72).
 */
export async function ownersPageQuestion(
  on: Schedules,
  title: string,
  earlier: string,
  message: string,
): Promise<{
  readonly conversation: ConversationScope;
  readonly messageId: string;
  readonly taskId: string;
}> {
  await asOwner(on);
  const taskId = await createTask(on, title);
  const conversation = await seedConversation(on);
  await on.db.admin.execute(
    `update public.conversations set scope_kind = 'task', scope_record_id = $2 where id = $1`,
    [conversation.id, taskId],
  );
  const turn = `insert into public.conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body, created_at)
     values ($1, $2, $3, 'person', $4, $5, clock_timestamp())`;
  await on.db.admin.execute(turn, [
    on.business,
    randomUUID(),
    conversation.id,
    on.decider.actorId,
    earlier,
  ]);
  const messageId = randomUUID();
  await on.db.admin.execute(turn, [
    on.business,
    messageId,
    conversation.id,
    on.decider.actorId,
    message,
  ]);
  return { conversation, messageId, taskId };
}
