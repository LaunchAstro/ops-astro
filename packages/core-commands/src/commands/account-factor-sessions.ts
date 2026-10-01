// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's half of a second-factor change (`account-factor.ts`): the change ends
// the person's other sessions, here and then at the provider. Split from
// `account-factor.ts` to keep that file under the line limit.

import { endOtherSeenSessions } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery, VerifiedSubject } from '../../../core-records/src/index.ts';
import type { FactorProvider, SessionsEnded } from './account-factor-provider.ts';

/**
 * A factor change ends the person's other sessions (C58): here, in
 * the change's own transaction, so they are refused from its commit.
 */
export async function endOthersOnChange(
  tx: TenantQuery,
  session: Session,
  presented: VerifiedSubject,
): Promise<number> {
  return await endOtherSeenSessions(
    tx,
    session.personId,
    presented.sessionId,
    'factor_change',
    presented.subject,
  );
}

/**
 * Then at the provider, with the session the code has just raised (the one
 * kept), which revokes every other session's refresh tokens. After the
 * commit: the change stands whatever the provider answers, and the answer
 * says whether it confirmed.
 */
export async function signOutOthers(
  provider: FactorProvider,
  accessToken: string,
  ended: number,
): Promise<SessionsEnded> {
  const signedOut = await provider.signOut(accessToken, 'others');
  return { ended, signedOutAtProvider: signedOut.ok };
}
