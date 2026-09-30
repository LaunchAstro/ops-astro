// SPDX-License-Identifier: AGPL-3.0-only
//
// Conversations for the matrix's cases (AW-03): one of bravo's, for the cases
// that compare a foreign conversation id with a fabricated one, written by the
// owner on bravo's own person actor so every key it names is bravo's; and one
// the caller starts, for the positive bodies that name a conversation.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

export async function foreignConversation(admin: AdminConnection, bravo: string): Promise<string> {
  const rows = await admin.execute<{ readonly id: string }>(
    `insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title)
     select a.business_id, gen_random_uuid(), a.id, a.person_id, 'a conversation of bravo'
       from public.actors a
      where a.business_id = $1 and a.person_id is not null
      order by a.id limit 1
     returning id`,
    [bravo],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('foreignConversation: bravo has no person actor');
  return id;
}

/** A conversation the caller just started, for the operations that name one (AW-03). */
export async function ownConversation(context: {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
}): Promise<string> {
  const started = await context.asPerson('conversation.start', {
    operationId: randomUUID(),
    body: 'a conversation to name',
  });
  const detail = started.body['detail'] as Record<string, unknown> | undefined;
  if (started.status !== 200 || typeof detail?.['conversationId'] !== 'string') {
    throw new Error(`matrix: conversation.start answered ${String(started.status)}`);
  }
  return detail['conversationId'];
}
