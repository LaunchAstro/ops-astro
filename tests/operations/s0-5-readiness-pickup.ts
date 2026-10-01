// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5 readiness (`s0-5-readiness.test.ts`): the gated calls only the agent
// makes, and the revoke of a live delegation, prepared on one pickup. Split
// from the test so it stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import type { Harness } from '../acceptance/role-case-harness.ts';

/** A gated command's call: a person's body, or the agent's under the credential it travels with. */
export interface Call {
  readonly body: Record<string, unknown>;
  readonly credential?: string;
}

/** The agent's own (AW-01, AW-11), and the revoke of a live delegation, all on one pickup. */
export const ON_THE_PICKUP: ReadonlySet<string> = new Set([
  'delegation.revoke',
  'model.call',
  'run.delegate_child',
  'run.child_handback',
]);

const detail = (answer: { readonly body: Record<string, unknown> }): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

/**
 * The calls made on one agent pickup. The world's one agent holds one live
 * delegation at a time, so the revoke's target, the model call, the hand-over
 * and the handback share it; the handback travels on a child credential
 * handed over here, while made-up. Made after every person body, as some of
 * those pick up runs of their own.
 */
export async function pickupCalls(harness: Harness): Promise<ReadonlyMap<string, Call>> {
  const task = await harness.freshTask(`s0-5 gate ${randomUUID()}`);
  const decided = await harness.reserve(task, 'draft_the_gate_reply');
  const picked = await harness.asAgent('task.pickup', {
    reservationId: detail(decided)['reservationId'],
  });
  if (picked.code !== 'ok') throw new Error(`s0-5 gate: pickup refused ${picked.code}`);
  const held = detail(picked);
  const credential = String(held['credential']);
  const lease = { leaseId: held['leaseId'], fence: held['fence'] };
  const child = () => ({
    ...lease,
    helperActorId: harness.world.agent.actorId,
    purpose: `s0_5_gate_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    collections: ['task'],
    actions: ['read'],
    expiresInSeconds: 600,
  });
  const handed = await harness.asAgent('run.delegate_child', child(), credential);
  if (handed.code !== 'ok') throw new Error(`s0-5 gate: hand-over refused ${handed.code}`);
  const tone = { name: 'tone', from: { recordId: task.id, key: 'title' } };
  return new Map<string, Call>([
    ['delegation.revoke', { body: { delegationId: held['delegationId'] } }],
    [
      'model.call',
      { body: { ...lease, operation: 'model.replay_compose', fields: [tone] }, credential },
    ],
    ['run.delegate_child', { body: child(), credential }],
    [
      'run.child_handback',
      { body: { outcome: 'completed' }, credential: String(detail(handed)['credential']) },
    ],
  ]);
}
