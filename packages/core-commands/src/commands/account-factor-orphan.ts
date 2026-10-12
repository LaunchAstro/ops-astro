// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor removed at the provider once this product's committed record holds
// it removed for the login (0064; removed is final): an enrolment that lost
// under the record lock, a removal the record has committed, a factor issued
// to an enrolment the record refused (held removed first), and a good code
// for a factor the record has since removed. One the provider will not remove
// is reported, and asked again on the login's next proven code (`catchUp`).
// A factor the record has not decided on stays where it is: it may be another
// business's enrolment in flight (#300).
// Split from `account-factor.ts` to keep that file under the line limit.

import {
  factorDigest,
  loginHasVerifiedFactor,
  loginRemovedFactors,
  recordStrayRemoved,
  withSession,
} from '../../../core-records/src/index.ts';
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
  // Removed by another act at once, or by an ask whose answer was lost: gone, not orphaned.
  const held = await provider.heldFactors(accessToken);
  if (held.ok && !held.value.includes(providerFactorId)) return;
  await reportOrphan(caller, { providerFactorId }, attempt, 'PROVIDER_ANSWER_INVALID');
}

/** Whether the login's committed record holds the factor removed. */
export async function heldRemoved(
  caller: FactorCaller,
  { providerFactorId }: { readonly providerFactorId: string },
): Promise<boolean> {
  const removed = await caller.database.withBusiness(caller.businessId, (tx) =>
    loginRemovedFactors(tx, caller.presented.subject),
  );
  return removed.includes(factorDigest(providerFactorId));
}

/** A factor issued to an enrolment the record refused: held removed, then removed there. */
export async function letStrayGo(
  caller: FactorCaller,
  provider: FactorProvider,
  stray: { readonly providerFactorId: string },
  attempt: string,
): Promise<void> {
  await caller.database.withBusiness(caller.businessId, (tx) =>
    recordStrayRemoved(tx, { subject: caller.presented.subject, ...stray }),
  );
  await removeAtProvider(caller, provider, caller, stray, attempt);
}

/**
 * After a code the provider proved, with the session it gave: every factor the
 * provider still holds for the login that the login's record holds removed is
 * removed there, so a removal the provider refused earlier is not left valid.
 */
export async function catchUp(
  caller: FactorCaller,
  provider: FactorProvider,
  session: { readonly accessToken: string },
  attempt: string,
  /** The act's own target, already removed or kept by the act itself. */
  handled: string,
): Promise<void> {
  // The record first: a login with nothing held removed asks the provider nothing.
  const removed = await caller.database.withBusiness(caller.businessId, (tx) =>
    loginRemovedFactors(tx, caller.presented.subject),
  );
  const pending = removed.filter((digest) => digest !== factorDigest(handled));
  if (pending.length === 0) return;
  const held = await provider.heldFactors(session.accessToken);
  if (!held.ok) return;
  for (const providerFactorId of held.value) {
    if (!pending.includes(factorDigest(providerFactorId))) continue;
    // oxlint-disable-next-line no-await-in-loop
    await removeAtProvider(caller, provider, session, { providerFactorId }, attempt);
  }
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
