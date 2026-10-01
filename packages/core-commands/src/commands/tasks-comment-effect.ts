// SPDX-License-Identifier: AGPL-3.0-only
//
// The one local effect's check (T2c2), for `task.comment` in `tasks-comment.ts`:
// an identity derived from an attempt is accepted only once that attempt's step
// is dispatched to the author's own lease on this task.

import { audienceNotPermitted, type TenantQuery } from '../../../core-records/src/index.ts';
import { acquire } from '../../../core-runtime/src/index.ts';
import { effectAttemptOf } from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/** What the effect check reads of the comment being written. */
export interface EffectTarget {
  readonly target: { readonly id: string };
  readonly authorActorId: string;
  readonly operationId: string;
  readonly delegationId: string | null;
}

const EFFECT_FIXES: readonly string[] = [
  'Dispatch the step under your own lease first; its answer names the attempt.',
  'Nothing was written.',
];

/**
 * The refusal an effect identity earns, or `undefined`: the one effect is a
 * team-only comment, on an attempt marked dispatched to the author's own lease
 * on this task. Any other identity is an ordinary comment and passes.
 *
 * T2d: the attempt must still be `dispatched`. Once observe has settled it, or
 * held it as an unknown liability, its outcome is recorded and a late effect
 * would contradict it. A retried effect is
 * unaffected: the register replays it before this runs.
 *
 * The step is found only through an attempt whose lease binds it to this task
 * and this author, so another client's attempt is refused before anything of
 * its is locked or waited on. That step is
 * then locked through the one lock helper and held to commit, and the check
 * runs again under it: observe takes the same lock, so it cannot settle the
 * attempt between this check and the comment's write.
 */
export async function effectRefusal(
  tx: TenantQuery,
  on: EffectTarget,
  audience: string,
): Promise<CommandRefusal | undefined> {
  const attemptId = effectAttemptOf(on.operationId);
  if (attemptId === undefined) return undefined;
  if (audience !== 'internal') {
    return audienceNotPermitted('The effect is a team-only comment. Send audience as internal.');
  }
  const found = await dispatchedToAuthor(tx, on, attemptId);
  if (found === undefined) return refuseCommand('EFFECT_NOT_DISPATCHED', [], EFFECT_FIXES);
  await acquire(tx, [{ lockClass: 'step', id: found.step_id }]);
  const held = await dispatchedToAuthor(tx, on, attemptId);
  return held === undefined ? refuseCommand('EFFECT_NOT_DISPATCHED', [], EFFECT_FIXES) : undefined;
}

/** The attempt's step, when the attempt is dispatched to the author's own lease on this task. */
async function dispatchedToAuthor(
  tx: TenantQuery,
  on: EffectTarget,
  attemptId: string,
): Promise<{ readonly step_id: string } | undefined> {
  const rows = await tx.query<{ readonly step_id: string }>(
    `select att.step_id from public.attempts att
       join public.leases l on l.business_id = att.business_id and l.id = att.lease_id
      where att.business_id = $1 and att.id = $2 and att.dispatch_marker
        and att.state = 'dispatched' and l.task_id = $3
        and l.holder_actor_id = $4 and l.delegation_id is not distinct from $5::uuid`,
    [tx.businessId, attemptId, on.target.id, on.authorActorId, on.delegationId],
  );
  return rows[0];
}
