// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { ConversationScope } from '../../packages/core-custody/src/index.ts';
import type { Schedules } from '../runtime/schedules-harness.ts';

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
