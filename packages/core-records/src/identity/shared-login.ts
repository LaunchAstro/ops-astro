// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a provider subject is still live in another business (C58, ORCH46
// ruling A): a login of that subject elsewhere, mapped to a person or an agent
// (a ban is provider-wide, so it would end an agent's sign-in too), whose
// access has not been ended there. Asked on the owner's connection, by subject
// alone, and answered as a yes or no: no business, person or count leaves it.
//
// The four tables are under forced row security, so the answer is only true
// on a role that sees past it (a superuser, or BYPASSRLS). On any other role
// every row is hidden and "not live elsewhere" would be a guess that bans a
// login still live in another business (#643). The same statement asks the
// server which it is, and the check refuses to answer rather than guess: an
// ending's provider steps then stay owed (`settleAccessEndings` reads a
// failed ask as not asked).

import type { AdminConnection } from '../tenancy/database.ts';

/** The owner connection does not see past row security, so the check would only guess. */
export class OwnerBehindRowSecurity extends Error {
  constructor() {
    super('loginLiveElsewhere: the owner connection does not see past row security; not answered');
    this.name = 'OwnerBehindRowSecurity';
  }
}

export async function loginLiveElsewhere(
  owner: Pick<AdminConnection, 'execute'>,
  subject: string,
  businessId: string,
): Promise<boolean> {
  const rows = await owner.execute<{ readonly sees: boolean | null; readonly live: boolean }>(
    `select (select r.rolsuper or r.rolbypassrls from pg_roles r where r.rolname = current_user)
              as sees,
            exists (
       select 1
         from public.logins l
        where l.provider = 'supabase' and l.subject = $1 and l.business_id <> $2
          and (exists (select 1 from public.person_logins m
                        where m.business_id = l.business_id and m.login_id = l.id and m.active)
               or exists (select 1 from public.actor_logins m
                           where m.business_id = l.business_id and m.login_id = l.id and m.active))
          and not exists (
            select 1 from public.access_endings e
             where e.business_id = l.business_id and e.login_id = l.id)
     ) as live`,
    [subject, businessId],
  );
  if (rows[0]?.sees !== true) {
    throw new OwnerBehindRowSecurity();
  }
  return rows[0].live;
}
