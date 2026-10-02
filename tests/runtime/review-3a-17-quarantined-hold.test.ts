// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-17: a quarantined hold is still held. The classifier keeps a
// marked attempt's full hold as `quarantined` for its reconciliation owner
// (`core-runtime/src/recovery/classifier.ts`, R7), and the envelope still
// carries it (`tests/runtime/handback-envelope-totals.test.ts`). The execution
// graph's `heldMinor` sums only reservations in state `held`
// (`reads/execution.ts`), so after the hand-back the node reads `heldMinor:
// null`, "nothing held", while the money is still reserved.
//
// The quarantine is reached the way the existing hand-back totals case
// reaches it: a dispatched attempt now goes to `liability_unknown` with its
// reservation left `held`, so only an attempt marked and already
// `quarantined` (a legacy or imported row, which 0014 kept quarantined)
// quarantines its reservation through `task.handback`.
//
// Fixed when the observed layer counts a quarantined reservation as held.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { appliedDetail, asAgent, handbackBody, liveWork, rows } from './schedules-harness.ts';
import { graphAs, nodeOf, noDatabase, useAw06World, w } from './aw-06-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('review3a17');

it('REVIEW-3A-17: a quarantined hold reads as held on the execution graph, not heldMinor null', async () => {
  const work = await liveWork(w.s, `review-3a-17-${randomUUID()}`, 1_500);
  const live = nodeOf(await graphAs(w.s.decider, work.taskId), work.picked['runId']);
  expect(live.observed).toMatchObject({ heldMinor: 1_500 });

  // A marked attempt, as the owner would find an imported or legacy one.
  await w.s.db.admin.execute(
    `update public.attempts set observed = true, state = 'quarantined'
      where business_id = $1 and id = $2`,
    [w.s.business, work.decision['attemptId']],
  );
  const handed = appliedDetail(
    await asAgent(w.s, handbackBody(work.picked), String(work.picked['credential'])),
    'task.handback of a marked attempt',
  );
  expect(handed['reservationState']).toBe('quarantined');
  const [reservation] = await rows<{ readonly state: string; readonly held: string }>(
    w.s,
    `select state, held_minor::text as held from public.reservations
      where business_id = $1 and id = $2`,
    [w.s.business, work.decision['reservationId']],
  );
  expect(reservation).toEqual({ state: 'quarantined', held: '1500' });

  const node = nodeOf(await graphAs(w.s.decider, work.taskId), work.picked['runId']);
  expect(
    node.observed['heldMinor'],
    'the quarantined reservation still holds 1500 but the graph reads nothing held',
  ).toBe(1_500);
});
