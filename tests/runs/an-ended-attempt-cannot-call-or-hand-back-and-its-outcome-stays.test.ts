// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1, `sol-1623-ended-attempt-cannot-call-or-handback`: once a stop has
// written an attempt's outcome and retired its work, the old holder's
// credential can neither read, dispatch, make a model call through the real
// broker door nor hand back on that lease, and none
// of its late calls writes a second outcome or changes the first (design R1,
// R2: the outcome row is an immutable observation of the stop, first writer
// wins). The control is a live attempt, which reads and hands back as before.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  handbackBody,
  liveWork,
  type Work,
} from '../runtime/schedules-harness.ts';
import { attemptOfLease, outcomesOfAttempt } from './run-outcomes-read.ts';
import { callsOf, modelCall, noDatabase, s, useStopWorld } from './run-stop-world.ts';

const outcomesOf = async (work: Work) => {
  const { attemptId } = await attemptOfLease(
    s.db.admin,
    s.business,
    String(work.picked['leaseId']),
  );
  return await outcomesOfAttempt(s.db.admin, s.business, attemptId);
};

/** The old holder's three late calls on its own lease, each under its own credential. */
const lateCalls = (work: Work) => {
  const credential = String(work.picked['credential']);
  const lease = { leaseId: work.picked['leaseId'], fence: work.picked['fence'] };
  return [
    [
      'task.read',
      async () =>
        await asAgent(
          s,
          { command: 'task.read', operationId: randomUUID(), recordId: work.taskId },
          credential,
        ),
    ],
    [
      'task.dispatch',
      async () =>
        await asAgent(
          s,
          { command: 'task.dispatch', operationId: randomUUID(), ...lease },
          credential,
        ),
    ],
    ['task.handback', async () => await asAgent(s, handbackBody(work.picked), credential)],
  ] as const;
};

// eslint-disable-next-line max-lines-per-function -- one world, a stop and its control
describe.skipIf(noDatabase)('an ended attempt', () => {
  // The broker's world, so a late model call crosses the real door and broker.
  useStopWorld('r1ended');

  it('after a cancel records its outcome, the old credential cannot read, dispatch or hand back, and the one outcome row stays as the cancel wrote it', async () => {
    const work = await liveWork(s, 'cancelled, then called late', 1_000);
    appliedDetail(
      await asPerson(s, {
        command: 'task.cancel',
        operationId: randomUUID(),
        recordId: work.taskId,
        lineageId: work.proposal['lineageId'],
        reason: 'stopped, then the old worker calls',
      }),
      'cancel',
    );
    const recorded = await outcomesOf(work);
    expect(recorded.map((row) => [row.outcome, row.end_code])).toStrictEqual([
      ['cancelled', 'TASK_CANCELLED'],
    ]);

    for (const [name, late] of lateCalls(work)) {
      // eslint-disable-next-line no-await-in-loop -- one late call at a time, each checked
      const answer = await late();
      expect(isCommandRefusal(answer), `${name} on an ended attempt`).toBe(true);
      // eslint-disable-next-line no-await-in-loop -- the row after each call
      expect(await outcomesOf(work), `${name} leaves the outcome as written`).toStrictEqual(
        recorded,
      );
    }

    // A late model call on the old credential, through the real door and broker.
    const late = await modelCall(work);
    expect(late.status, 'model.call on an ended attempt').not.toBe(200);
    expect(await callsOf(work), 'the late call holds nothing').toEqual([]);
    expect(await outcomesOf(work), 'model.call leaves the outcome as written').toStrictEqual(
      recorded,
    );
  });

  it('control: a live attempt reads its task and hands back, and nothing in R1 stops it', async () => {
    const work = await liveWork(s, 'live, reads and hands back', 1_000);
    const [read, , handback] = lateCalls(work);
    expect(isCommandRefusal(await read[1]()), 'live read').toBe(false);
    expect(isCommandRefusal(await handback[1]()), 'live handback').toBe(false);
  });
});
