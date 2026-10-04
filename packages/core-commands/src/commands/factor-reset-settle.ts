// SPDX-License-Identifier: AGPL-3.0-only
//
// The provider step a factor reset owes (C59, ORCH65-Q3): the admin removal
// of the member's factor at the sign-in provider, never asked inside a
// database transaction. Tried by the local server as soon as the reset
// commits, and retried by the endings loop until it is done, as C58's endings
// are (`access-end.ts`, `settleAccessEndings`). Done is stamped once and never
// asked again, and nothing is stamped on a step once it is done. An answer the
// adapter does not accept, a throw or a timeout is a fault by its kind alone,
// and the step stays owed.

import type { BusinessId, Database } from '../../../core-records/src/index.ts';
import type { LoginProvider, SettleReport } from './access-end.ts';
import type { ProviderAnswer } from './account-factor-provider.ts';

/** As C58's claim: longer than one provider call can take (a 5-second limit). */
export const FACTOR_RESET_CLAIM_SECONDS = 30;

interface Owed {
  readonly id: string;
  readonly subject: string;
  readonly provider_factor_id: string;
}

/**
 * One pass over this business's resets with the step owed, claimed one row
 * at a time (SEC-B1 M4): a row is claimed just before its call, so a pass of
 * slow calls never lets a claim lapse on a row still waiting its turn. A claim
 * takes a row no other settle has claimed inside `claimSeconds`, and skips one
 * another settle holds locked. The provider is called outside any
 * transaction, and its answer stamped in a second one only while the row is
 * still owed, so a late answer never re-dates a step done or puts a fault on it.
 */
export async function settleFactorResets(
  database: Database,
  businessId: BusinessId,
  provider: LoginProvider,
  options: {
    readonly claimSeconds?: number;
    /** Only these resets: the one an act has just written. All owed ones otherwise. */
    readonly only?: readonly string[];
  } = {},
): Promise<SettleReport> {
  const claimSeconds = options.claimSeconds ?? FACTOR_RESET_CLAIM_SECONDS;
  const tried: string[] = [];
  let settled = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one reset at a time, each claimed before its call
    const row = await claimNext(database, businessId, claimSeconds, options.only ?? null, tried);
    if (row === undefined) break;
    tried.push(row.id);
    // eslint-disable-next-line no-await-in-loop -- one reset at a time, each its own call
    const answer = await removed(provider, row);
    // eslint-disable-next-line no-await-in-loop -- its stamp, before the next is claimed
    await database.withBusiness(businessId, async (tx) => {
      await tx.query(
        `update public.factor_resets
            set done_at = case when $3 then now() end, last_fault = $4
          where business_id = $1 and id = $2 and done_at is null`,
        [businessId, row.id, answer.ok, answer.ok ? null : answer.fault],
      );
    });
    if (answer.ok) settled += 1;
  }
  return {
    attempted: tried.length,
    settled,
    owed: await stillOwed(database, businessId, options.only),
  };
}

/**
 * The resets of this business (of `only`, when named) still owed after the
 * pass: those it tried and failed, and those it skipped under another
 * attempt's live claim, which are owed until that attempt stamps them done.
 */
async function stillOwed(
  database: Database,
  businessId: BusinessId,
  only: readonly string[] | undefined,
): Promise<number> {
  const [row] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly owed: number }>(
        `select count(*)::int as owed from public.factor_resets
          where business_id = $1 and done_at is null
            and ($2::uuid[] is null or id = any($2::uuid[]))`,
        [businessId, only ?? null],
      ),
  );
  return row?.owed ?? 0;
}

/** The next owed reset no other settle holds, claimed; none when nothing is left. */
async function claimNext(
  database: Database,
  businessId: BusinessId,
  claimSeconds: number,
  only: readonly string[] | null,
  tried: readonly string[],
): Promise<Owed | undefined> {
  const [row] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<Owed>(
        `update public.factor_resets r
            set attempts = r.attempts + 1, attempt_started_at = now()
           from public.logins l
          where r.id = (
                  select o.id from public.factor_resets o
                   where o.business_id = $1 and o.done_at is null
                     and (o.attempt_started_at is null
                          or o.attempt_started_at <= now() - make_interval(secs => $2))
                     and ($3::uuid[] is null or o.id = any($3::uuid[]))
                     and o.id <> all($4::uuid[])
                   order by o.reset_at, o.id
                   limit 1
                   for update skip locked)
            and r.business_id = $1 and l.business_id = r.business_id and l.id = r.login_id
          returning r.id, l.subject, r.provider_factor_id`,
        [businessId, claimSeconds, only, tried],
      ),
  );
  return row;
}

/** The removal. An adapter without one, or a throw, is a fault by its kind, never its words. */
async function removed(provider: LoginProvider, row: Owed): Promise<ProviderAnswer<void>> {
  if (provider.deleteFactor === undefined) return { ok: false, fault: 'unreachable' };
  try {
    return await provider.deleteFactor(row.subject, row.provider_factor_id);
  } catch {
    return { ok: false, fault: 'unreachable' };
  }
}
