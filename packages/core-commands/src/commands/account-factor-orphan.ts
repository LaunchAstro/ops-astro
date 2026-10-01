// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor removed at the provider once this product has decided it goes
// (`account-factor.ts`): an enrolment that lost, under the record lock, to a
// factor the login verified elsewhere, or a removal the record has committed.
// Split from `account-factor.ts` to keep that file under the line limit
// (security review 2b2, finding 1).

import { withSession } from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { FactorProvider } from './account-factor-provider.ts';
import type { FactorCaller } from './account-factor.ts';
import { writeAuditEvent } from './audit.ts';

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
  // Without the presented session: the act may have ended it (C58) or been
  // refused for it, and the orphan must still be written.
  // Login, person and actor are still resolved and checked as on every call.
  const { sessionId: _ended, ...login } = caller.presented;
  await withSession(
    caller.database,
    caller.businessId,
    login,
    async (tx, session) => {
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command: ORPHANED,
        operationId: attempt,
        outcome: 'refused',
        refusalCode: 'PROVIDER_ANSWER_INVALID',
        payloadDigest: payloadDigest({
          command: ORPHANED,
          person: session.personId,
          providerFactorId,
        }),
      });
    },
    'enrolling',
  );
}
