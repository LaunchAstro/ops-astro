// SPDX-License-Identifier: AGPL-3.0-only
//
// The provider step a factor reset owes (C59, ORCH65-Q3): the admin removal
// of the member's factor at the sign-in provider, never asked inside a
// database transaction. Tried by the local server as soon as the reset
// commits, and retried by the endings loop until it is done, as C58's endings
// are (`access-end.ts`, `settleAccessEndings`). Done is stamped once and never
// asked again. An answer the adapter does not accept, a throw or a timeout is
// a fault by its kind alone, and the step stays owed.

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
 * One pass over this business's resets with the step owed. The claim is one
 * statement: a row it returns is one no other settle has claimed inside
 * `claimSeconds`, and a second settle waiting on the row lock re-reads the
 * claim and passes over it. The provider is called outside any transaction,
 * and what it answered is stamped in a second one; `coalesce` keeps the first
 * stamp, so a step done is never re-dated.
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
  const claimed = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<Owed>(
        `update public.factor_resets r
            set attempts = r.attempts + 1, attempt_started_at = now()
           from public.logins l
          where r.business_id = $1 and l.business_id = r.business_id and l.id = r.login_id
            and r.done_at is null
            and (r.attempt_started_at is null
                 or r.attempt_started_at <= now() - make_interval(secs => $2))
            and ($3::uuid[] is null or r.id = any($3::uuid[]))
          returning r.id, l.subject, r.provider_factor_id`,
        [businessId, claimSeconds, options.only ?? null],
      ),
  );
  let settled = 0;
  for (const row of claimed) {
    // eslint-disable-next-line no-await-in-loop -- one reset at a time, each its own call
    const answer = await removed(provider, row);
    // eslint-disable-next-line no-await-in-loop -- its stamp, before the next is asked
    await database.withBusiness(businessId, async (tx) => {
      await tx.query(
        `update public.factor_resets
            set done_at = case when $3 then coalesce(done_at, now()) else done_at end,
                last_fault = $4
          where business_id = $1 and id = $2`,
        [businessId, row.id, answer.ok, answer.ok ? null : answer.fault],
      );
    });
    if (answer.ok) settled += 1;
  }
  return { attempted: claimed.length, settled, owed: claimed.length - settled };
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
