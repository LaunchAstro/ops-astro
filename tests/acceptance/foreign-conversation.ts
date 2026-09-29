// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation of bravo's (AW-03), for the cases that compare a foreign
// conversation id with a fabricated one. Written by the owner on bravo's own
// person actor, so every key it names is bravo's.
//
// A harness, not a suite: nothing here runs on its own.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

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
