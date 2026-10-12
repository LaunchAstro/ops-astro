// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent working for one client picks up none of another client's work
// (`agentReach`, core-runtime/src/pickup.ts). A fixture whose one agent holds
// work for several clients, or for a client and for none, at once makes each
// pickup with the agent's other standing delegations run out, and puts them
// back afterwards, so the cases read the delegations they always had.

import type { AdminConnection } from '../../packages/core-records/src/index.ts';

export async function besideOtherWork<T>(
  admin: AdminConnection,
  agentActorId: string,
  pickup: () => Promise<T>,
): Promise<T> {
  // A microsecond after its grant, the earliest expiry a delegation may hold.
  const aside = await admin.execute<{ readonly id: string; readonly at: string }>(
    `update public.delegations d set expires_at = d.granted_at + interval '1 microsecond'
       from public.delegations was
      where was.id = d.id and d.agent_actor_id = $1 and d.expires_at > now()
     returning d.id, was.expires_at::text as at`,
    [agentActorId],
  );
  try {
    return await pickup();
  } finally {
    await admin.execute(
      `update public.delegations d set expires_at = back.at
         from unnest($1::uuid[], $2::timestamptz[]) as back (id, at) where d.id = back.id`,
      [aside.map((row) => row.id), aside.map((row) => row.at)],
    );
  }
}
