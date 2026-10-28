// SPDX-License-Identifier: AGPL-3.0-only
//
// A person writes a hold off while its call is still `dispatched`: the
// write-off records its outcome only on calls already held unknown, so this
// call keeps no outcome, and the sweep then holds it unknown. Nobody can
// close it after that, since the hold is closed. A write-off at 0 leaves the
// step's effect unknown (#2277), so a pickup of the closed hold is refused:
// no replacement runs the step again, no stop is raised on the hold for a
// top-up to mark it counted, and a later release of the call gives back
// nothing the envelope never carried for it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLAY_NOTHING_HAPPENED } from '../../packages/core-connectors/src/index.ts';
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
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  askOf,
  callState,
  dispatchedCall,
  envelopeOf,
  holdsOf,
  moneyOf,
  roomyWork,
  spend,
  stopWorker,
  sweep,
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
 * sweep then holds c2 unknown. A pickup of the first hold is refused (#2277):
 * the replacement that held the 200 left, and the stop for room it led to on
 * the first hold, no longer arise.
 */
async function pickedUpAfterWriteOffWhileDispatched() {
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
  const before = await moneyOf(s, work, versionId);

  const picked = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: first,
    leaseSeconds: 600,
  });
  const held = (await holdsOf(s, versionId)).filter((hold) => hold.state === 'held');
  const call = { state: await callState(s, c2), outcome: await outcomeOf(c2) };
  return { work, versionId, first, c2, picked, held, call, before, ...(await askOf(s, first)) };
}

describe.skipIf(serverUrl === undefined)(
  'a pickup of a hold written off while its call was dispatched',
  () => {
    // No stop is raised on the written-off hold, so the top-up this case
    // refused and the end it applied have no ask to answer; what they
    // guarded, the hold never read as counted and no money moved, is kept.
    it('refuses a pickup of a hold written off at 0 while its call was dispatched, moving nothing and raising no stop to top up', async () => {
      const { work, versionId, first, picked, held, call, before, runId, askId } =
        await pickedUpAfterWriteOffWhileDispatched();
      expect({
        picked: codeOf(picked),
        held,
        call,
        ask: askId,
        answers: await answersOn(s, runId),
        money: await moneyOf(s, work, versionId),
        counted: await counted(s, first),
      }).toEqual({
        picked: 'RESERVATION_NOT_CLAIMABLE',
        held: [],
        call: { state: 'liability_unknown', outcome: null },
        ask: undefined,
        answers: 0,
        money: before,
        counted: false,
      });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'a release of the call on a hold written off while it was dispatched',
  () => {
    it("keeps the envelope's actual at the written-off 300 when the provider's proof later releases the call", async () => {
      const { work, first, c2, picked } = await pickedUpAfterWriteOffWhileDispatched();
      const before = await envelopeOf(s, work);
      // The reconciliation pass asks only about a call whose step is held
      // unknown, and the write-off abandoned the step, so the pass leaves c2
      // alone. The provider's proof that nothing happened reaches c2 as the
      // worker's late answer instead, which releases it the same way.
      const passed = await reconcileProviderCalls(s.db.app, s.business, LATE_BROKER);
      // #1623 R1 (B2): only a reason the operation declares proves nothing happened;
      // any other is held unknown. The proof is the replay operation's own code.
      await answerLate(s, work.picked, c2, { kind: 'nothing', reason: REPLAY_NOTHING_HAPPENED });
      const after = await envelopeOf(s, work);
      const [envelope] = after as readonly { actual: string }[];
      expect({
        picked: codeOf(picked),
        passed,
        call: await callState(s, c2),
        actual: envelope?.actual,
        envelope: after,
        counted: await counted(s, first),
      }).toEqual({
        picked: 'RESERVATION_NOT_CLAIMABLE',
        passed: [],
        call: 'released',
        actual: '300',
        envelope: before,
        counted: false,
      });
    });
  },
);
