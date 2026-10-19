// SPDX-License-Identifier: AGPL-3.0-only
//
// `review.carry_pins` (C35-X, #2075, #2014 slice A): the worker carries a review's pins onto
// its new revision, under the live lease on the review's task, as `review.capture_land` lands
// its pictures. The lease is held and re-checked, the revision's capture rows are locked, so
// carries onto one revision run one at a time, and the lease and the authority behind it are
// judged again at the instant read after that wait (`review-captures.ts`). Every width must
// have landed (CARRY_NOT_READY). Each pin not yet carried there is carried once, found again
// or lost (`carries.ts`); a pin is never closed or changed. The operation's audit names the
// revision, and each comment it carried gets an event of its own, so the comment's history
// shows `comment carried forward`. Neither the actor nor the lease comes from the body.

import {
  carryPinsOnto,
  landedCarryTarget,
  lockRevisionCaptures,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import {
  fieldsRefused,
  holdLease,
  invalidLease,
  personCaller,
  stillHeld,
  type CaptureCaller,
  type LeaseFields,
} from './review-captures.ts';

const NOT_FOUND = refuseCommand(
  'NOT_FOUND',
  [],
  ['Name a revision of a review on your lease’s task.'],
);
const NOT_READY = refuseCommand(
  'CARRY_NOT_READY',
  ['revisionId'],
  ['Land the revision’s capture at every width, then carry its pins.'],
);

interface CarryFields extends LeaseFields {
  readonly operationId: unknown;
}

export async function carryPins(
  tx: TenantQuery,
  fields: CarryFields,
  caller: CaptureCaller,
): Promise<HandlerOutcome> {
  const wrong = invalidLease(fields);
  if (wrong.length > 0) {
    return fieldsRefused(wrong, 'Send the fence the pickup handed back and the revision.');
  }
  const held = await holdLease(tx, fields, caller);
  if ('refusal' in held) return refused(held.refusal);
  const revisionId = String(fields.revisionId).toLowerCase();
  const locked = await lockRevisionCaptures(tx, revisionId, held.lease);
  if ('code' in locked) return refused(NOT_FOUND);
  const lapsed = await stillHeld(tx, held.lease, caller);
  if (lapsed !== null) return refused(lapsed);
  const target = await landedCarryTarget(tx, revisionId);
  if (target === undefined) return refused(NOT_READY);
  const carried = await carryPinsOnto(tx, target.review, target.to, {
    leaseId: held.lease.leaseId,
    fence: held.lease.fence,
    actorId: caller.holderActorId,
    operationId: String(fields.operationId),
  });
  const lost = carried.filter((one) => one.state === 'lost').length;
  return {
    ...applied(revisionId, null, { revisionId, moved: carried.length - lost, lost }),
    carried: carried.map((one) => ({ recordId: one.commentId })),
  };
}

/** The person entry: their own pickup's lease. */
export const carryPinsAsPerson = async (
  tx: TenantQuery,
  context: CommandContext,
  request: CarryFields,
): Promise<HandlerOutcome> => await carryPins(tx, request, personCaller(context));
