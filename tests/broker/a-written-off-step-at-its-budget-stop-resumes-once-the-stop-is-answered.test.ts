// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof (round 2 on #1387, #1314): written-off work at its budget stop
// resumes on a different recorded outcome, and the resumed hold can be picked
// up, by the recovery itself or once a person answers the stop.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { people, setThreshold, usePeople } from './budget-answers-world.ts';
import { answer, stoppedAfterItsEffect, observeOver } from './observed-hold-world.ts';
import { appliedDetail, asPerson, codeOf } from '../runtime/schedules-harness.ts';

useBrokerWorld('sol1387budgetresume');
usePeople();

it.skipIf(noDatabase)(
  'Sol proof, criterion 4: a different recorded outcome can resume written-off work at its budget stop',
  async () => {
    await setThreshold(null);
    const { w, lease, runId, askId } = await stoppedAfterItsEffect();
    expect(await observeOver(w, lease)).toBe('BUDGET_UNAVAILABLE');
    expect(
      await answer(people.approver, {
        command: 'budget.write_off',
        recordId: w.taskId,
        attemptId: w.attemptId,
        amountMinor: 100,
        reason: 'Later evidence shows the work happened differently.',
      }),
    ).toBe('applied');
    // Supply ample envelope authority for a replacement. The old write-off remains charged.
    appliedDetail(
      await asPerson(s, {
        command: 'budget.top_up',
        operationId: randomUUID(),
        recordId: w.taskId,
        amountMinor: 500,
        fromMaximumMinor: 500,
      }),
      'budget.top_up',
    );
    const outcome = await asPerson(s, {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: w.taskId,
      attemptId: w.attemptId,
      outcome: 'happened_differently',
    });
    expect(appliedDetail(outcome, 'budget.record_outcome')['resumed']).toContain(
      'resumed as attempt',
    );
    const [next] = await s.db.admin.execute<{ id: string }>(
      `select id from public.reservations where run_id = $1 and state = 'held' and lease_id is null`,
      [runId],
    );
    expect(next).toBeDefined();
    const picked = await asPerson(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: next?.id,
    });
    // Recovery may itself clear the stop, or require the holder to answer the
    // outstanding ask. A replacement that neither route can claim is stranded.
    if (codeOf(picked) !== 'applied') {
      expect(codeOf(picked)).toBe('RESERVATION_NOT_CLAIMABLE');
      expect(
        await answer(people.approver, {
          command: 'run.top_up',
          recordId: w.taskId,
          runId,
          askId,
          amountMinor: 500,
          currency: 'AUD',
        }),
      ).toBe('applied');
      const [available] = await s.db.admin.execute<{ id: string }>(
        `select id from public.reservations where run_id = $1 and state = 'held' and lease_id is null
           order by created_at desc limit 1`,
        [runId],
      );
      expect(
        codeOf(
          await asPerson(s, {
            command: 'task.pickup',
            operationId: randomUUID(),
            reservationId: available?.id,
          }),
        ),
      ).toBe('applied');
    }
  },
);
