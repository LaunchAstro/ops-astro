// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a stored success of a command asked of a lease (its declaration's
// `runtimeShaped: 'leaseId'`) may still go out: only while that lease is still
// the caller's, as the command's fresh call asks it (#2332). Both entries ask
// it after the replay's last wait: the person envelope's `lastCheck`
// (`envelope.ts`) and the agent's `JUDGED_AGAIN` (`agent-replay-again.ts`). A
// pickup's receipt is its lease, and `pickup-receipt.ts` asks that one.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import {
  leaseHeldAt,
  leaseReason,
  lockedInstant,
  type LeaseClaimant,
} from '../../../core-runtime/src/index.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

const LEASE_REPLAY_FIX =
  'A repeated request is answered only while the lease it was sent under is still yours. Pick the work up again.';

/**
 * Where a lease command's call asks less than the whole lease: a handback and
 * a run's end end the lease themselves, so their replay asks nothing of it, and
 * an observation settles an expired lease's money (T2d), so its replay asks
 * only the holder and the fence. Every other lease command asks it all.
 */
const ASKED_OF_THE_LEASE: Readonly<Record<string, 'nothing' | 'holder'>> = {
  'task.handback': 'nothing',
  'run.end': 'nothing',
  'task.observe': 'holder',
};

/** The refusal a lease command's replay meets now, or nothing. */
export async function leaseLapsed(
  tx: TenantQuery,
  declaration: CommandDeclaration,
  request: Readonly<Record<string, unknown>>,
  caller: LeaseClaimant,
): Promise<CommandRefusal | undefined> {
  if (declaration.runtimeShaped !== 'leaseId') return undefined;
  const asked = ASKED_OF_THE_LEASE[declaration.name] ?? 'all';
  if (asked === 'nothing') return undefined;
  const { leaseId, fence } = request;
  if (!isIdentifier(leaseId) || typeof fence !== 'number') {
    return refuseCommand('LEASE_NOT_OWNED', [], [leaseReason('not_owned'), LEASE_REPLAY_FIX]);
  }
  const held = await leaseHeldAt(
    tx,
    caller,
    { leaseId, fence },
    await lockedInstant(tx),
    LEASE_REPLAY_FIX,
    asked === 'all',
  );
  return held === undefined || held.ok ? undefined : held.refusal;
}
