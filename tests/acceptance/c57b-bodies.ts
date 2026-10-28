// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part B's positive body for the role-case matrix (#2117), kept apart from
// `c35-bodies.ts` for its line cap: the change request approved, and the admin's own lease on
// the review's task (EX-01), under which the request is made a task.

import type { BodyContext, Prepared } from './role-case-bodies.ts';
import { PROPOSAL } from './role-case-bodies.ts';

/** `decision` is the approving `review.decide_change` body `c35-bodies.ts` prepared. */
export async function makeTaskBody(
  context: BodyContext,
  taskId: unknown,
  decision: Prepared,
): Promise<Prepared> {
  if (!('body' in decision)) return decision;
  const decided = await context.asPerson('review.decide_change', decision.body);
  if (decided.code !== 'ok')
    throw new Error(`matrix: review.decide_change refused ${decided.code}`);
  const read = await context.asPerson('task.read', { recordId: taskId });
  const proposed = await context.asPerson('task.propose', {
    recordId: taskId,
    expectedRevision: (read.body['task'] as { revision: number }).revision,
    ...PROPOSAL,
  });
  if (proposed.code !== 'ok') throw new Error(`matrix: task.propose refused ${proposed.code}`);
  const gate = proposed.body['detail'] as Readonly<Record<string, unknown>>;
  const approved = await context.asPerson('task.decide', {
    gateId: gate['gateId'],
    versionId: gate['versionId'],
    decision: 'approve',
    note: 'approved so the request can be made a task',
  });
  if (approved.code !== 'ok') throw new Error(`matrix: task.decide refused ${approved.code}`);
  const { reservationId } = approved.body['detail'] as Readonly<Record<string, unknown>>;
  const picked = await context.asPerson('task.pickup', { reservationId });
  if (picked.code !== 'ok') throw new Error(`matrix: task.pickup refused ${picked.code}`);
  const lease = picked.body['detail'] as Readonly<Record<string, unknown>>;
  const { changeRequestId } = decision.body;
  return { body: { leaseId: lease['leaseId'], fence: lease['fence'], changeRequestId } };
}
