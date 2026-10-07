// SPDX-License-Identifier: AGPL-3.0-only
//
// A step result's authority, asked again once its onboarding's lock is held (C41-A).

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

/** The caller's authority asked again under the onboarding's lock: the refusal, or undefined. */
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

/** A person or API-2 caller: task grants held before the lock, then expiry and `task:write` asked at the locked clock. */
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

/** A delegated agent: its person's grants held, then the delegation (and parent) held and asked live at the locked clock. */
export async function delegationStillHolds(
  tx: TenantQuery,
  delegation: Pick<Delegation, 'id' | 'delegatePersonId'>,
): Promise<StillHolds> {
  const person: readonly Subject[] = [{ kind: 'person', id: delegation.delegatePersonId }];
  await holdCoveringGrants(tx, person, 'task');
  return async ({ taskId }) => {
    // Held, then read in its own statement (fresh clock); child and parent in id order, as `acquire` takes them.
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
