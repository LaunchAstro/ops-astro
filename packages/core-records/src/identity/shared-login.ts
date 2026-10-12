// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a provider subject is still live in another business (C58, ORCH46
// ruling A): a login of that subject elsewhere, mapped to a person or an agent
// (a ban is provider-wide, so it would end an agent's sign-in too), by a
// mapping no access ending there names (20261012155000). Asked on the owner's
// connection, by subject alone, and answered as a yes or no: no business,
// person or count leaves it.

import type { AdminConnection } from '../tenancy/database.ts';

export async function loginLiveElsewhere(
  owner: Pick<AdminConnection, 'transaction'>,
  subject: string,
  businessId: string,
): Promise<boolean> {
  return await owner.transaction(async (execute) => {
    // A role that does not bypass row security is refused (42501), never
    // answered "not live" from the rows its policies leave it.
    await execute('set local row_security = off');
    const rows = await execute<{ readonly live: boolean }>(
      `select exists (
         select 1
           from public.logins l
          where l.provider = 'supabase' and l.subject = $1 and l.business_id <> $2
            and (exists (select 1 from public.person_logins m
                          where m.business_id = l.business_id and m.login_id = l.id and m.active
                            and not exists (
                              select 1 from public.access_endings e
                               where e.business_id = l.business_id and e.login_id = l.id
                                 and e.person_mapping_id = m.id))
                 or exists (select 1 from public.actor_logins m
                             where m.business_id = l.business_id and m.login_id = l.id and m.active
                               and not exists (
                                 select 1 from public.access_endings e
                                  where e.business_id = l.business_id and e.login_id = l.id
                                    and e.actor_mapping_id = m.id)))
       ) as live`,
      [subject, businessId],
    );
    return rows[0]?.live === true;
  });
}
