// SPDX-License-Identifier: AGPL-3.0-only
//
// A person writes a hold off while its call is still `dispatched`: the
// write-off records its outcome only on calls already held unknown, so this
// call keeps no outcome, and the sweep then holds it unknown. Nobody can
// close it after that, since the hold is closed. A stop raised on that closed
// hold takes no top-up: the top-up would mark the hold counted, and a later
// release of the call would give back 200 the envelope never carried for it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileProviderCalls } from '../../packages/core-custody/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  pickup,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  askOf,
  callState,
  dispatchedCall,
  envelopeOf,
  moneyOf,
  roomyWork,
  spend,
  stampBefore,
  stopWorker,
  sweep,
  topUp,
} from './version-room-world.ts';
import { answerLate, answersOn, attemptOf, counted, LATE_BROKER } from './written-off-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/written-off-while-dispatched: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('written_off_dispatched', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
    await installBusinessSettings(tx);
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

async function outcomeOf(callId: string): Promise<string | null | undefined> {
  const [call] = await rows<{ outcome: string | null }>(
    s,
    'select outcome from public.model_calls where business_id = $1 and id = $2',
    [s.business, callId],
  );
  return call?.outcome;
}

/**
 * The first hold's call c2 is still `dispatched` when a person writes the
 * hold off at 0, so it closes at its settled 300 and c2 keeps no outcome; the
 * sweep then holds c2 unknown. The replacement holds the 200 left, spends it
 * and stops, stamped before the first hold, so picking the first hold up
 * stops the run for room.
 */
async function stopOnWrittenOffWhileDispatched() {
  const { work, versionId, first } = await roomyWork(s);
  await spend(s, first, 300);
  const c2 = await dispatchedCall(s, first, 200);
  // The fence holds the step unknown at the whole hold, c2 still `dispatched`.
  await stopWorker(s, work.picked);
  const writtenOff = await asPerson(
    s,
    writeOffBody({ taskId: work.taskId, attemptId: await attemptOf(s, first) }, 0),
  );
  appliedDetail(writtenOff, 'budget.write_off');
  await sweep(s);

  const second = await pickup(s, first);
  await spend(s, second['reservationId'], 200);
  await stopWorker(s, second);
  await stampBefore(s, first, second['reservationId']);
  const stopped = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: first,
    leaseSeconds: 600,
  });
  const call = { state: await callState(s, c2), outcome: await outcomeOf(c2) };
  return { work, versionId, first, c2, stopped, call, ...(await askOf(s, first)) };
}

describe.skipIf(serverUrl === undefined)(
  'a top-up on a hold written off while its call was dispatched',
  () => {
    it('refuses a top-up on a hold written off while its call was dispatched, moving nothing, and lets the end apply', async () => {
      const { work, versionId, first, stopped, call, runId, askId } =
        await stopOnWrittenOffWhileDispatched();
      const before = await moneyOf(s, work, versionId);

      const topped = await topUp(s, work, first, 100);
      expect({
        stopped: codeOf(stopped),
        call,
        code: codeOf(topped),
        answers: await answersOn(s, runId),
        money: await moneyOf(s, work, versionId),
        counted: await counted(s, first),
      }).toEqual({
        stopped: 'BUDGET_UNAVAILABLE',
        call: { state: 'liability_unknown', outcome: null },
        code: 'TRANSITION_NOT_PERMITTED',
        answers: 0,
        money: before,
        counted: false,
      });

      const ended = await asPerson(s, {
        command: 'run.end_at_budget_stop',
        operationId: randomUUID(),
        recordId: work.taskId,
        runId,
        askId,
      });
      expect({
        code: codeOf(ended),
        money: await moneyOf(s, work, versionId),
        counted: await counted(s, first),
      }).toEqual({ code: 'applied', money: before, counted: false });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'a release of the call after a top-up on a hold written off while it was dispatched',
  () => {
    it("keeps the envelope's actual at 500 when the provider's proof later releases the call", async () => {
      const { work, first, c2 } = await stopOnWrittenOffWhileDispatched();
      const topped = await topUp(s, work, first, 100);
      // The reconciliation pass asks only about a call whose step is held
      // unknown, and the write-off abandoned the step, so the pass leaves c2
      // alone. The provider's proof that nothing happened reaches c2 as the
      // worker's late answer instead, which releases it the same way.
      const passed = await reconcileProviderCalls(s.db.app, s.business, LATE_BROKER);
      await answerLate(s, work.picked, c2, { kind: 'nothing', reason: 'provider_proof' });
      const [envelope] = (await envelopeOf(s, work)) as readonly { actual: string }[];
      expect({
        topped: codeOf(topped),
        passed,
        call: await callState(s, c2),
        actual: envelope?.actual,
      }).toEqual({
        topped: 'TRANSITION_NOT_PERMITTED',
        passed: [],
        call: 'released',
        actual: '500',
      });
    });
  },
);
