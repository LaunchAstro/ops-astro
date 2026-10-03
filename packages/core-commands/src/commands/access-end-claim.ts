// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's retry statements for access endings (`settleAccessEndings`,
// `access-end.ts`): the claim on the next owed ending, one row at a time.

import type { BusinessId, Database } from '../../../core-records/src/index.ts';

export interface OwedEnding {
  readonly id: string;
  readonly login_id: string;
  readonly subject: string;
  readonly sessions_done: boolean;
  readonly login_done: boolean;
}

/**
 * The next owed ending no other retry holds, claimed; none when nothing is
 * left. A claim takes a row no other retry has claimed inside `claimSeconds`,
 * skips one another retry holds locked, and never one this pass has `tried`.
 */
export async function claimNextEnding(
  database: Database,
  businessId: BusinessId,
  claimSeconds: number,
  only: readonly string[] | null,
  tried: readonly string[],
): Promise<OwedEnding | undefined> {
  const [row] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<OwedEnding>(
        `update public.access_endings e
            set attempts = e.attempts + 1, attempt_started_at = now()
           from public.logins l
          where e.id = (
                  select o.id from public.access_endings o
                   where o.business_id = $1
                     and (o.sessions_ended_at is null or o.login_deactivated_at is null)
                     and (o.attempt_started_at is null
                          or o.attempt_started_at <= now() - make_interval(secs => $2))
                     and ($3::uuid[] is null or o.id = any($3::uuid[]))
                     and o.id <> all($4::uuid[])
                   order by o.id
                   limit 1
                   for update skip locked)
            and e.business_id = $1 and l.business_id = e.business_id and l.id = e.login_id
          returning e.id, e.login_id, l.subject,
                    e.sessions_ended_at is not null as sessions_done,
                    e.login_deactivated_at is not null as login_done`,
        [businessId, claimSeconds, only, tried],
      ),
  );
  return row;
}
