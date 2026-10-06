// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's last authority read. Each C80 write is admitted on authority read
// before its lock waits (the door's grant check, an agent's delegation, the
// covering grant when the correction was locked), and a grant revoked or
// expired, or a delegation ended, while the write waited keeps nothing. So
// once the write has met its row locks, the grants it rests on are
// share-locked (a revocation after this waits for the commit), an agent's
// delegation is too, the audit chain's lock is taken (the envelope's last
// wait, as `tasks-agent.ts` takes it), and the authority is read again at
// that statement's own clock.

import {
  advisoryLock,
  coveredAt,
  DELEGATION_STANDS_AT_CHECK,
  holdCoveringGrants,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Covering, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

export interface Standing {
  readonly covering: Covering;
  /** Where the grant must reach: the correction's party, or null for business-wide only. */
  readonly partyId: string | null;
  /** An agent's delegation, which must still stand as well. */
  readonly delegationId?: string;
}

/** What the last read found: the write stands, or which authority had ended. */
export type Stood = 'stands' | 'grant-ended' | 'delegation-ended';

export async function standsAfterWaits(tx: TenantQuery, standing: Standing): Promise<Stood> {
  const { covering, partyId, delegationId } = standing;
  await holdCoveringGrants(tx, covering);
  if (delegationId !== undefined) {
    await tx.query(
      `select d.id from public.delegations d where d.business_id = $1 and d.id = $2
          for share of d`,
      [tx.businessId, delegationId],
    );
  }
  await advisoryLock(tx, tx.businessId.toLowerCase());
  if (delegationId !== undefined) {
    const rows = await tx.query<{ readonly live: boolean }>(
      `select ${DELEGATION_STANDS_AT_CHECK} as live from public.delegations d
        where d.business_id = $1 and d.id = $2`,
      [tx.businessId, delegationId],
    );
    if (rows[0]?.live !== true) return 'delegation-ended';
  }
  return (await coveredAt(tx, covering, partyId)) ? 'stands' : 'grant-ended';
}

/** A business-wide write's own key (its declaration's), held by the writer after its waits. */
export async function writerStillHolds(
  tx: TenantQuery,
  { session, declaration }: Pick<CommandContext, 'session' | 'declaration'>,
): Promise<Stood> {
  const { collection, action } = declaration;
  return await standsAfterWaits(tx, {
    covering: { subjects: subjectsOf(session), collection, action },
    partyId: null,
  });
}

const GRANT_ENDED = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);
const NARROWED = refuseCommand(
  'DELEGATION_NARROWED',
  [],
  ['the authority this delegation draws on was revoked or narrowed; ask for it again'],
);
const NOT_LIVE = refuseCommand(
  'DELEGATION_NOT_LIVE',
  [],
  ['ask the authorising person for a current delegation'],
);

/** The refusal for an authority that ended during a wait, in the words its first check uses. */
export function endedRefusal(stood: Exclude<Stood, 'stands'>, agent: boolean): CommandRefusal {
  if (!agent) return GRANT_ENDED;
  return stood === 'grant-ended' ? NARROWED : NOT_LIVE;
}
