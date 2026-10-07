// SPDX-License-Identifier: AGPL-3.0-only
//
// Another business's pending team invitation (C39-T), written as the owner,
// for the cells that aim an `invitationId` across the business line.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

export async function foreignInvitation(admin: AdminConnection, bravo: string): Promise<string> {
  const rows = await admin.execute<{ readonly id: string }>(
    `with creator as (
       select id from public.actors where business_id = $1 and person_id is not null
        order by id limit 1),
     person as (
       insert into public.people (business_id, id, display_name)
       values ($1, gen_random_uuid(), 'an invitee of bravo') returning id)
     insert into public.invitations
       (business_id, id, person_id, role_key, address, expires_at, created_by_actor_id)
     select $1, gen_random_uuid(), person.id, 'member',
            'invitee-' || gen_random_uuid() || '@example.test',
            now() + interval '1 day', creator.id
       from person, creator
     returning id`,
    [bravo],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('foreignInvitation: bravo has no person actor');
  return id;
}
