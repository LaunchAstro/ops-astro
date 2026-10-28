// SPDX-License-Identifier: AGPL-3.0-only
//
// #2321: the pass's last phase. A write-off stops a replacement the pass reserved for its
// step (`write-off.ts`), but one at nothing recorded before #2282 stopped none: the
// replacement stays held, its money held in the envelope, for a step that never runs again
// (#2277). The pass stops it as a write-off does today (`stopReplacement`): its lease ends, its
// delegation is revoked and its hold goes back by amount, naming the attempt written off.
// One already dispatched is left, as a write-off leaves it. One whose model call is out keeps
// its hold until the call settles, and a later pass stops it then.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { RuntimeInvariantError } from '../only.ts';
import { lockRediscovered } from '../rediscovery.ts';
import { stepWrittenOff, writtenOffAttemptOf } from '../step-written-off.ts';
import { stopReplacement } from './outcome.ts';
import { locksOf, UNKNOWN_SELECT, type Unknown } from './reconcile.ts';

/**
 * Held replacements of written-off steps, never dispatched, in this business only. One whose
 * lease is no longer live is the sweep's to classify first.
 */
async function discoverHeld(tx: TenantQuery): Promise<readonly Unknown[]> {
  return await tx.query<Unknown>(
    `${UNKNOWN_SELECT}
      where att.business_id = $1 and att.state in ('reserved', 'dispatched')
        and not att.dispatch_marker and not att.observed
        and res.state = 'held' and (l.id is null or l.state = 'live')
        and ${stepWrittenOff('att.business_id', 'att.step_id')}
      order by att.id`,
    [tx.businessId],
  );
}

/**
 * The phase, in the caller's transaction on the tenancy connection. Discover, lock with each
 * step's set, rediscover (`covered`: one a concurrent pass stopped drops out), then stop each
 * in turn under those locks. The attempts it stopped or kept for their open call.
 */
export async function stopWrittenOffReplacements(tx: TenantQuery): Promise<readonly string[]> {
  const { found } = await lockRediscovered(tx, {
    discover: async () => await discoverHeld(tx),
    locks: locksOf,
    rule: 'covered',
    changed:
      'written-off replacements: the set changed under discovery; roll back and stop them on the next pass',
  });
  for (const row of found) {
    // Sequential: each moves the envelope the next may share.
    // eslint-disable-next-line no-await-in-loop
    const writtenOff = await writtenOffAttemptOf(tx, row.attempt_id);
    // Discovered written off, and a write-off is never undone (0007, 0014).
    if (writtenOff === undefined) throw new RuntimeInvariantError('written-off replacements: none');
    // eslint-disable-next-line no-await-in-loop
    await stopReplacement(tx, { ...row, marked: false }, writtenOff);
  }
  return found.map((row) => row.attempt_id);
}
