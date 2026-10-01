// SPDX-License-Identifier: AGPL-3.0-only
//
// Factors the provider holds for a login that this product never recorded
// (`account-factor.ts`): an enrolment the provider issued but whose record step
// refused or never ran, verified there or not (a good code whose record lost to
// a newer enrolment leaves one verified). A refusal does not remove them, since
// by the time it is known the factor may be another tab's; the person's next
// enrolment or removal does, here. Split from `account-factor.ts` to keep that file under
// the line limit.

import { createHash, randomUUID } from 'node:crypto';
import { liveFactor, withSession, type TenantQuery } from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { FactorProvider } from './account-factor-provider.ts';
import type { FactorCaller } from './account-factor.ts';
import { writeAuditEvent } from './audit.ts';

const RECONCILED = 'account.factor_reconciled';

/**
 * One listing at the provider; then, under the login's and the person's
 * lock, every factor with no live record of the person's here, and never
 * recorded as verified through any business (0064), is removed, and each
 * removal gets an audit event. A factor this business records, verified or
 * not, and any factor any business recorded as verified, is never touched.
 * A listing or removal that fails changes nothing and is tried again at the
 * next act.
 */
export async function reconcileFactors(
  caller: FactorCaller,
  provider: FactorProvider,
): Promise<void> {
  const listed = await provider.list(caller.accessToken);
  if (!listed.ok || listed.value.length === 0) return;

  const strays = await withSession(
    caller.database,
    caller.businessId,
    caller.presented,
    async (tx, session) => {
      await liveFactor(tx, session.personId, { lock: caller.presented.subject });
      const kept = await recordedFactors(tx, session.personId, caller.presented.subject);
      return listed.value.filter(({ factorId }) => !kept(factorId));
    },
    'enrolling',
  );
  if (!Array.isArray(strays) || strays.length === 0) return;

  const removed: string[] = [];
  for (const { factorId } of strays) {
    // oxlint-disable-next-line no-await-in-loop
    if ((await provider.remove(caller.accessToken, factorId)).ok) removed.push(factorId);
  }
  if (removed.length === 0) return;
  const operationId = randomUUID();
  await withSession(
    caller.database,
    caller.businessId,
    caller.presented,
    async (tx, session) => {
      for (const providerFactorId of removed) {
        // oxlint-disable-next-line no-await-in-loop
        await writeAuditEvent(tx, {
          actorId: session.actorId,
          command: RECONCILED,
          operationId,
          outcome: 'applied',
          payloadDigest: payloadDigest({
            command: RECONCILED,
            person: session.personId,
            providerFactorId,
          }),
        });
      }
    },
    'enrolling',
  );
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Whether the provider's factor is one to keep: live in this business's
 * record of the person, or recorded as verified through any business (0064).
 */
async function recordedFactors(
  tx: TenantQuery,
  personId: string,
  subject: string,
): Promise<(factorId: string) => boolean> {
  const here = await tx.query<{ readonly provider_factor_id: string }>(
    `select provider_factor_id from public.second_factors
      where business_id = $1 and person_id = $2 and status <> 'removed'`,
    [tx.businessId, personId],
  );
  const anywhere = await tx.query<{ readonly factor_digest: string }>(
    `select factor_digest from ops.second_factor_subjects
      where subject_digest = $1 and state = 'verified'`,
    [digest(subject)],
  );
  const live = new Set(here.map((row) => row.provider_factor_id));
  const verified = new Set(anywhere.map((row) => row.factor_digest));
  return (factorId) => live.has(factorId) || verified.has(digest(factorId));
}
