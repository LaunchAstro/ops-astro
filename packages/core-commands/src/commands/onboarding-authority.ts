// SPDX-License-Identifier: AGPL-3.0-only
//
// A step result's authority, asked again once its onboarding's lock is held
// (C41-A). `onboarding.step_result` waits on that lock after the envelope or
// the delegation check has admitted it, so a revocation, or a lapse, during
// the wait is seen there, and one that comes after it waits for the write.

import {
  DELEGATION_STANDS_AT_CHECK,
  subjectsOf,
  type Delegation,
  type Session,
  type Subject,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import { credentialNotLive } from './credential-not-live.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/**
 * The caller's authority asked again once the onboarding's lock is held, of
 * the step's task and client as read under it: the refusal, or undefined.
 */
export type StillHolds = (step: {
  readonly clientId: string;
  readonly taskId: string;
}) => Promise<CommandRefusal | undefined>;

const NOT_LIVE = refuseCommand(
  'DELEGATION_NOT_LIVE',
  [],
  ['ask the authorising person for a current delegation'],
);

// `resolveDelegation`'s words: no grant, time or person is named.
const NARROWED = refuseCommand(
  'DELEGATION_NARROWED',
  [],
  ['the authority this delegation draws on was revoked or narrowed; ask for it again'],
);

/** Whether an API-2 credential is unrevoked and unexpired at the locked clock. */
async function credentialStandsAt(
  tx: TenantQuery,
  credentialId: string,
  at: string,
): Promise<boolean> {
  const [row] = await tx.query<{ readonly live: boolean }>(
    `select (c.revoked_at is null and c.expires_at > $3::timestamptz) as live
       from public.agent_credentials c where c.business_id = $1 and c.id = $2`,
    [tx.businessId, credentialId, at],
  );
  return row?.live === true;
}

/**
 * The envelope's caller, a person or an API-2 credential: its task grants are
 * held for share now, before the onboarding's lock (grants before records, as
 * `task.decide` holds them), so a revocation that comes second waits for the
 * write; and, at the clock once the lock is held, a credential's own expiry
 * and `task:write` at the step's client are asked again, so a grant revoked
 * first, or a grant or credential that lapsed during the wait, no longer
 * counts. A credential's row is already held for share (its revocation waits).
 */
export async function grantsStillHold(tx: TenantQuery, session: Session): Promise<StillHolds> {
  const subjects = subjectsOf(session);
  await holdCoveringGrants(tx, subjects, 'task');
  return async ({ clientId }) => {
    const at = await lockedInstant(tx);
    // A credential call signs in as its credential: its id is the login id.
    if (
      session.credentialScope !== undefined &&
      !(await credentialStandsAt(tx, session.loginId, at))
    ) {
      return credentialNotLive();
    }
    const held = await checkAuthorityAt(
      tx,
      subjects,
      { collection: 'task', action: 'write', scope: { kind: 'party', id: clientId } },
      at,
    );
    return held.ok ? undefined : held.refusal;
  };
}

/**
 * A delegated agent's: the delegating person's task grants held for share
 * now, before the onboarding's lock, as the person path holds its own, so a
 * revocation of one comes after the write. Once the lock is held, the
 * delegation, and a child's parent with it, is held `for share` (after the
 * task rows, as the lock order puts a delegation) and must be live at the
 * clock, so a `delegation.revoke` of either after that read waits too; and the
 * person's `task:write` on the step's task is asked at that clock. A revocation
 * for lost authority, or the person's grant lapsing during the wait, is
 * `DELEGATION_NARROWED`, as the agent envelope answers it; any other end is
 * `DELEGATION_NOT_LIVE`.
 */
export async function delegationStillHolds(
  tx: TenantQuery,
  delegation: Pick<Delegation, 'id' | 'delegatePersonId'>,
): Promise<StillHolds> {
  const person: readonly Subject[] = [{ kind: 'person', id: delegation.delegatePersonId }];
  await holdCoveringGrants(tx, person, 'task');
  return async ({ taskId }) => {
    // Held first, then read in a statement of its own: a locking read
    // computes its columns before it waits, so a row released unchanged would
    // otherwise answer with the clock from before the wait. A child's parent
    // is held with it, as its liveness is read; the two in id order, as
    // `acquire` takes a class's rows, so a revocation costing both cannot
    // hold one while this holds the other.
    await tx.query(
      `select d.id from public.delegations d
        where d.business_id = $1
          and (d.id = $2
               or d.id = (select c.parent_delegation_id from public.delegations c
                           where c.business_id = $1 and c.id = $2))
        order by d.id
          for share of d`,
      [tx.businessId, delegation.id],
    );
    const [row] = await tx.query<{ readonly live: boolean; readonly narrowed: boolean }>(
      `select ${DELEGATION_STANDS_AT_CHECK} as live,
              (d.revoked_at is not null and d.settled_at is null
               and d.expires_at > clock_timestamp()
               and d.revocation_cause = 'authority_lost') as narrowed
         from public.delegations d
        where d.business_id = $1 and d.id = $2`,
      [tx.businessId, delegation.id],
    );
    if (row?.live !== true) return row?.narrowed === true ? NARROWED : NOT_LIVE;
    const held = await checkAuthorityAt(
      tx,
      person,
      { collection: 'task', action: 'write', scope: { kind: 'record', id: taskId } },
      await lockedInstant(tx),
    );
    return held.ok ? undefined : NARROWED;
  };
}
