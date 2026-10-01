// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor removed at the provider once this product has decided it goes
// (`account-factor.ts`): an enrolment that lost, under the record lock, to a
// factor the login verified elsewhere, or a removal the record has committed.
// And a stray the product leaves there, reported: a factor issued or proven
// at the provider whose record was then refused.
// Split from `account-factor.ts` to keep that file under the line limit.

import { loginHasVerifiedFactor, withSession } from '../../../core-records/src/index.ts';
import type { RefusalCode, Session, TenantQuery } from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { FactorProvider } from './account-factor-provider.ts';
import type { FactorCaller } from './account-factor-judged.ts';
import { writeRefusedAuditEvent } from './envelope.ts';

const ORPHANED = 'account.factor_orphaned';

/**
 * Remove the factor at the provider, asking twice. If it still stands, an
 * `account.factor_orphaned` event names it (by digest) in this business, so
 * an authenticator valid at the provider and not in the record is not lost
 * from sight.
 */
export async function removeAtProvider(
  caller: FactorCaller,
  provider: FactorProvider,
  { accessToken }: { readonly accessToken: string },
  { providerFactorId }: { readonly providerFactorId: string },
  /** The act's operation id, so the two rows join. */
  attempt: string,
): Promise<void> {
  for (let asked = 0; asked < 2; asked += 1) {
    // oxlint-disable-next-line no-await-in-loop
    if ((await provider.remove(accessToken, providerFactorId)).ok) return;
  }
  await reportOrphan(caller, { providerFactorId }, attempt, 'PROVIDER_ANSWER_INVALID');
}

/**
 * An `account.factor_orphaned` event naming a factor the provider holds and
 * the record does not, joined to the act by its operation id. Nothing is
 * removed at the provider.
 */
export async function reportOrphan(
  caller: FactorCaller,
  { providerFactorId }: { readonly providerFactorId: string },
  attempt: string,
  why: RefusalCode,
): Promise<void> {
  // Without the presented session: the act may have ended it (C58) or been
  // refused for it, and the orphan must still be written.
  // Login, person and actor are still resolved and checked as on every call.
  const { sessionId: _ended, ...login } = caller.presented;
  const written = await withSession(
    caller.database,
    caller.businessId,
    login,
    async (tx, session) => {
      await writeRefusedAuditEvent(tx, {
        actorId: session.actorId,
        command: ORPHANED,
        operationId: attempt,
        refusalCode: why,
        payloadDigest: payloadDigest({
          command: ORPHANED,
          person: session.personId,
          providerFactorId,
        }),
      });
      return true;
    },
    'enrolling',
  );
  // Login resolution refused (membership ended, person archived): no row can
  // be written here, so the server log carries it, digests only.
  if (written !== true) {
    console.warn(
      `${ORPHANED} unrecorded: business=${caller.businessId} operation=${attempt} ` +
        `subject=${payloadDigest({ command: ORPHANED, subject: caller.presented.subject })}`,
    );
  }
}

/** A verified factor here, or one the login holds through any business (0064). */
export const holdsVerified = async (
  tx: TenantQuery,
  caller: FactorCaller,
  live: { readonly status: string } | undefined,
): Promise<boolean> =>
  live?.status === 'verified' || (await loginHasVerifiedFactor(tx, caller.presented.subject));

/** The caller's factor, and the login's subject that holds it in every business (0064). */
export const ownFactor = (
  caller: FactorCaller,
  session: Session,
  factorId: string,
): { readonly personId: string; readonly factorId: string; readonly subject: string } => ({
  personId: session.personId,
  factorId: factorId,
  subject: caller.presented.subject,
});
