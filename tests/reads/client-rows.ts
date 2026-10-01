// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's client is a client row of its business (C32): `task.set_party`
// refuses an identifier no client of the business carries, NOT_FOUND. The read
// worlds name their clients by identifier, so each one is made a row of the
// business it is placed in before a task is put under it.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

/** The client `clientId` as a row of `businessId`, made once, written by its first actor. */
export async function clientHere(
  admin: AdminConnection,
  businessId: string,
  clientId: string,
): Promise<string> {
  await admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     select $1, $2::uuid, 'client ' || left($2::text, 8), a.id
       from public.actors a where a.business_id = $1
      order by a.created_at, a.id limit 1
     on conflict (id) do nothing`,
    [businessId, clientId],
  );
  return clientId;
}
