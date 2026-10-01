// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a provider subject is still live in another business (C58, ORCH46
// ruling A): a login of that subject elsewhere, mapped to a person, whose
// access has not been ended there. Asked on the owner's connection, by subject
// alone, and answered as a yes or no: no business, person or count leaves it.

import type { AdminConnection } from '../tenancy/database.ts';

export async function loginLiveElsewhere(
  owner: Pick<AdminConnection, 'execute'>,
  subject: string,
  businessId: string,
): Promise<boolean> {
  const rows = await owner.execute<{ readonly live: boolean }>(
    `select exists (
       select 1
         from public.logins l
         join public.person_logins m
           on m.business_id = l.business_id and m.login_id = l.id and m.active
        where l.provider = 'supabase' and l.subject = $1 and l.business_id <> $2
          and not exists (
            select 1 from public.access_endings e
             where e.business_id = l.business_id and e.login_id = l.id)
     ) as live`,
    [subject, businessId],
  );
  return rows[0]?.live === true;
}
