// SPDX-License-Identifier: AGPL-3.0-only
//
// Success is written by the review handback (#1623 R2, R3): a `completed`
// handback records its attempt's `success / COMPLETED` in the transaction
// that settles the work. It is refused, before the handback writes anything,
// for an attempt that is not clean:
//
// - an outcome row of any kind is already recorded: a stop came first;
// - a model call of the attempt is still `reserved`, `dispatched` or of
//   unknown liability: its answer, or its release, is still owed;
// - the step carries a mark nothing has accounted for (design R2's step-level
//   unknown): the provider may have acted, and the work is the reconciliation
//   owner's, not a success. The attempt's own observation accounts for its
//   dispatch once it settles: the effect is in the operation register and its
//   cost is priced, so the attempt is `settled` as `completed`. A mark that
//   observation never settled (an unpriced report, a legacy `observed` with no
//   dispatch, a write-off that kept the outcome `unknown`, a mark on a lease
//   that launched nothing) stays unknown.
//
// One mark hands back without success (INB-1, #287 A2): a launched step
// dispatched and never observed. Its hold stays whole for a person, who
// records what happened, and the launcher's move is owed, whatever the holder
// reported; so the handback settles and records the attempt's outcome as
// `unknown_provider_outcome / LIABILITY_UNKNOWN`, never a success.
//
// Each is read under the handback's locks, which take the run, the lease and
// the reservation before any model call (`locks.ts`), so no call reserves or
// settles between this check and the success row.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** What the attempt on a lease holds that bars its success, read under the handback's locks. */
const CLEANLINESS = `select exists (select 1 from public.run_outcomes o
                 where o.business_id = a.business_id and o.attempt_id = a.id) as ended,
        exists (select 1 from public.model_calls c
                 where c.business_id = a.business_id and c.lease_id = a.lease_id
                   and c.state in ('reserved', 'dispatched', 'liability_unknown')) as open,
        (a.dispatch_marker or a.observed)
          and not (a.dispatch_marker and a.observed
                   and a.state = 'settled' and a.outcome = 'completed') as marked,
        a.dispatch_marker and not a.observed and a.state = 'dispatched'
          and exists (select 1 from public.reservations r
                        join public.reviewed_outputs ro on ro.business_id = r.business_id
                                                       and ro.version_id = r.version_id
                       where r.business_id = a.business_id and r.id = a.reservation_id)
          as unobserved_launch
   from public.attempts a
  where a.business_id = $1 and a.lease_id = $2`;

/**
 * The code a completed handback records for the attempt on `leaseId`: `COMPLETED` when it is
 * clean, `LIABILITY_UNKNOWN` for a launched step dispatched and never observed, or why it cannot
 * hand back.
 */
export async function completedEndCode(
  tx: TenantQuery,
  leaseId: string,
): Promise<RuntimeResult<'COMPLETED' | 'LIABILITY_UNKNOWN'>> {
  const [attempt] = await tx.query<{
    readonly ended: boolean;
    readonly open: boolean;
    readonly marked: boolean;
    readonly unobserved_launch: boolean;
  }>(CLEANLINESS, [tx.businessId, leaseId]);
  if (attempt === undefined) return { ok: true, value: 'COMPLETED' };
  if (attempt.ended) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'this attempt already stopped, and its outcome is recorded',
      'Read the run outcome on the execution read; a stopped attempt hands back nothing.',
    );
  }
  if (attempt.open) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'a model call of this attempt has not settled',
      'Hand back once every call has its answer, or end the run with its own code.',
    );
  }
  if (attempt.unobserved_launch) return { ok: true, value: 'LIABILITY_UNKNOWN' };
  if (attempt.marked) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      "this attempt's step is marked, and what the provider did is unknown",
      'Hand the work back as dropped; a person records what happened.',
    );
  }
  return { ok: true, value: 'COMPLETED' };
}
