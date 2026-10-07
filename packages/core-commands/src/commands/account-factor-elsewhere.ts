// SPDX-License-Identifier: AGPL-3.0-only
//
// A code entered in a business that holds no factor row for the person, for
// the factor the login verified through another business (C59, 0064). The
// provider holds one set of factors per login, so it is the same factor and
// the same code; this business only has to learn which factor it is. The
// provider lists the login's verified factors, read with the person's own
// token, and the one whose digest the login's record holds is the one checked.
// Nothing is recorded here: the factor stays held, and is removed, where it
// was verified. Split from `account-factor.ts` to keep that file under the
// line limit.

import { factorDigest, loginVerifiedFactors } from '../../../core-records/src/index.ts';
import type { SecondFactor, TenantQuery } from '../../../core-records/src/index.ts';
import { providerRefusal, type FactorProvider } from './account-factor-provider.ts';
import type { FactorCaller } from './account-factor-judged.ts';
import type { CommandRefusal } from './refusal.ts';

/** The factor a code is checked against: this business's row, or, with no `id`, one held elsewhere. */
export type CodeTarget = Pick<SecondFactor, 'providerFactorId' | 'status'> & {
  readonly id?: string;
};

/**
 * The login's factor held elsewhere, among those the provider lists as
 * verified: the first whose digest is in `held` (`loginVerifiedFactors`), or
 * undefined when none is. A fault in the listing is the provider's answer
 * refused. Called between transactions, never inside one.
 */
export async function heldElsewhere(
  caller: FactorCaller,
  provider: FactorProvider,
  held: readonly string[],
): Promise<CodeTarget | CommandRefusal | undefined> {
  const listed = await provider.verifiedFactors(caller.accessToken);
  if (!listed.ok) return providerRefusal(listed.fault, 'answer');
  const providerFactorId = listed.value.find((id) => held.includes(factorDigest(id)));
  return providerFactorId === undefined ? undefined : { providerFactorId, status: 'verified' };
}

/** Whether the login still holds `target` verified through some business, read under its lock. */
export async function stillHeld(
  tx: TenantQuery,
  caller: FactorCaller,
  target: CodeTarget,
): Promise<boolean> {
  const held = await loginVerifiedFactors(tx, caller.presented.subject);
  return held.includes(factorDigest(target.providerFactorId));
}
