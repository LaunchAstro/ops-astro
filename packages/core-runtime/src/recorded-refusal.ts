// SPDX-License-Identifier: AGPL-3.0-only
//
// When a top-up at a budget stop cannot apply because the stopped step's
// outcome is already settled (`budget-answer.ts`): written off with its
// effect unknown, or recorded as done after the run stopped. Either way the
// end still answers the stop. Split from `budget-stop.ts` for its line limit.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/**
 * A step written off with its effect unknown, at any time: a top-up cannot apply; the end does.
 *
 * A step settled `completed` in any transaction but the ask's own (a person's `happened` or
 * `happened_differently`, a worker's observed `completed`): a top-up cannot apply; the end does.
 * Both stamps are now(), each its transaction's start, which can invert across transactions,
 * so only equal stamps mark a settle and ask in one transaction, which would still top up;
 * no path raises that today.
 */
export async function recordedRefusal(
  tx: TenantQuery,
  stop: { readonly reservation_id: string; readonly ask_id: string },
): Promise<RuntimeResult<never> | null> {
  // A positive write-off settles the step at an unknown outcome (`write-off.ts`),
  // and nothing else does. Its effect may have happened, so a top-up must not
  // run it again, whenever the write-off landed: no stamp comparison here.
  const writtenOff = await tx.query(
    `select 1 from public.attempts
      where business_id = $1 and reservation_id = $2 and state = 'settled' and outcome = 'unknown'`,
    [tx.businessId, stop.reservation_id],
  );
  if (writtenOff.length > 0) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'this step was written off with its effect unknown, so a top-up cannot run it again',
      'End the work, or propose the step again for a person to approve.',
    );
  }
  const done = await tx.query(
    `select 1 from public.attempts a join public.budget_asks k on k.business_id = a.business_id
      where a.business_id = $1 and a.reservation_id = $2 and k.id = $3 and a.state = 'settled'
        and a.outcome = 'completed' and a.settled_at is distinct from k.raised_at`,
    [tx.businessId, stop.reservation_id, stop.ask_id],
  );
  if (done.length === 0) return null;
  const why = "this step's outcome was recorded after the run stopped, so a top-up cannot apply";
  return refuse('TRANSITION_NOT_PERMITTED', why, 'End the work instead.');
}
