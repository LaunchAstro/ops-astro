// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's retry statements for access endings (`settleAccessEndings`,
// `access-end.ts`): the claim on the next owed ending, one row at a time, the
// login's lock with its stamps read again under it, and the count of endings a
// business still owes.

import { lockLoginSubject } from '../../../core-records/src/index.ts';
import type { BusinessId, Database, TenantQuery } from '../../../core-records/src/index.ts';

/**
 * How long an ending waits for its login's lock (`lock_timeout`) before it
 * gives up unstamped, a fault, and stays owed for the next pass, so a contended login
 * never holds a connection (the local server has one) for longer. With both
 * calls' time limits it stays inside the claim.
 */
export const ACCESS_ENDING_LOCK_WAIT_MS = 5000;

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

/**
 * The claimed ending's login lock (`lockLoginSubject`), waiting at most
 * `lockWaitMs` (a timeout throws 55P03), then its stamps as they are now, its
 * row locked to the end of the transaction. Read under the lock, so a step
 * another retry stamped while this one waited (its claim lapsed meanwhile) is
 * not asked again. A row gone owes nothing.
 */
export async function lockEnding(
  tx: TenantQuery,
  row: OwedEnding,
  lockWaitMs: number = ACCESS_ENDING_LOCK_WAIT_MS,
): Promise<OwedEnding> {
  await tx.query(`select set_config('lock_timeout', $1, true)`, [`${String(lockWaitMs)}ms`]);
  await lockLoginSubject(tx, row.subject);
  const [now] = await tx.query<Pick<OwedEnding, 'sessions_done' | 'login_done'>>(
    `select sessions_ended_at is not null as sessions_done,
            login_deactivated_at is not null as login_done
       from public.access_endings where business_id = $1 and id = $2
        for update`,
    [tx.businessId, row.id],
  );
  return { ...row, sessions_done: now?.sessions_done ?? true, login_done: now?.login_done ?? true };
}

/** Every ending of the business still owing a step, one another retry holds included. */
export async function endingsOwed(
  database: Database,
  businessId: BusinessId,
  only: readonly string[] | null,
): Promise<number> {
  const [row] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly owed: number }>(
        `select count(*)::int as owed from public.access_endings
          where business_id = $1 and (sessions_ended_at is null or login_deactivated_at is null)
            and ($2::uuid[] is null or id = any($2::uuid[]))`,
        [businessId, only],
      ),
  );
  return row?.owed ?? 0;
}
