// SPDX-License-Identifier: AGPL-3.0-only
//
// A step result's authority, asked again once its onboarding's lock is held
// (C41-A). `onboarding.step_result` waits on that lock after the envelope or
// the delegation check has admitted it, so a revocation, or a lapse, during
// the wait is seen there, and one that comes after it waits for the write.

import {
  DELEGATION_STANDS_AT_CHECK,
  subjectsOf,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/**
 * The caller's authority asked again once the onboarding's lock is held, of
 * the step's client as read under it: the refusal, or undefined.
 */
export type StillHolds = (clientId: string) => Promise<CommandRefusal | undefined>;

/**
 * The envelope's caller, a person or an API-2 credential: its task grants are
 * held for share now, before the onboarding's lock (grants before records, as
 * `task.decide` holds them), so a revocation that comes second waits for the
 * write; and `task:write` at the step's client is asked at the clock once the
 * lock is held, so one that committed first, or a grant that lapsed during
 * the wait, no longer counts.
 */
export async function grantsStillHold(tx: TenantQuery, session: Session): Promise<StillHolds> {
  const subjects = subjectsOf(session);
  await holdCoveringGrants(tx, subjects, 'task');
  return async (clientId) => {
    const held = await checkAuthorityAt(
      tx,
      subjects,
      { collection: 'task', action: 'write', scope: { kind: 'party', id: clientId } },
      await lockedInstant(tx),
    );
    return held.ok ? undefined : held.refusal;
  };
}

/**
 * A delegated agent's: its delegation read `for share` (after the task rows,
 * as the lock order puts a delegation), live at the clock now. A revocation
 * that committed during the wait is seen; one after this waits for the write.
 */
export function delegationStillHolds(tx: TenantQuery, delegationId: string): StillHolds {
  return async () => {
    const [row] = await tx.query<{ readonly live: boolean }>(
      `select ${DELEGATION_STANDS_AT_CHECK} as live from public.delegations d
        where d.business_id = $1 and d.id = $2 for share of d`,
      [tx.businessId, delegationId],
    );
    return row?.live === true
      ? undefined
      : refuseCommand(
          'DELEGATION_NOT_LIVE',
          [],
          ['ask the authorising person for a current delegation'],
        );
  };
}
