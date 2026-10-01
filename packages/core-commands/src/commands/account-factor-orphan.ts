// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor the provider verified but this product refused to record
// (`account-factor.ts`, any refusal after the provider's yes): removed at the
// provider, so the login holds one authenticator, not two. Split from `account-factor.ts`
// to keep that file under the line limit (security review 2b2, finding 1).

import { withSession } from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { FactorProvider } from './account-factor-provider.ts';
import type { FactorCaller } from './account-factor.ts';
import { writeAuditEvent } from './audit.ts';

const ORPHANED = 'account.factor_orphaned';

/**
 * Remove the refused factor at the provider, asking twice. If it still stands,
 * an `account.factor_orphaned` event names it (by digest) in this business, so
 * the second authenticator, valid at the provider, is not lost from sight.
 */
export async function removeRefusedFactor(
  caller: FactorCaller,
  provider: FactorProvider,
  { accessToken }: { readonly accessToken: string },
  { providerFactorId }: { readonly providerFactorId: string },
): Promise<void> {
  for (let asked = 0; asked < 2; asked += 1) {
    // oxlint-disable-next-line no-await-in-loop
    if ((await provider.remove(accessToken, providerFactorId)).ok) return;
  }
  // Without the presented session: the refusal may be that the winning
  // enrolment has just ended it (C58), and the orphan must still be written.
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
