// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's write-off closes a hold whose call was sent and never answered:
// the call stays unknown, its outcome recorded, and nothing resolves it again.
// A stop raised on that closed hold takes no top-up, since a top-up would
// mark the hold as one that counted its open calls: the version room would
// count the written-off call again, and a late settle of it would give back
// money the envelope never carried. The end at the stop still applies.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  askOf,
  callState,
  committed,
  dispatchedCall,
  envelopeOf,
  holdsOf,
  moneyOf,
  roomyWork,
  spend,
  stampBefore,
  stopWorker,
  sweep,
  topUp,
} from './version-room-world.ts';
import { answerLate, answersOn, attemptOf, counted, priced } from './written-off-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/top-up-on-a-written-off-hold: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('written_off_stop', 1_000_000);
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

/**
 * A person writes off the first hold at 0 while its dispatched call is held
 * unknown, so it closes at its settled 300 with the call still open. The
 * replacement holds the 200 left, spends it and stops, stamped before the
 * first hold, so picking the first hold up stops the run for room.
 */
async function stopOnWrittenOff() {
  const { work, versionId, first } = await roomyWork(s);
  await spend(s, first, 300);
  const c2 = await dispatchedCall(s, first, 200);
  // The worker's authority goes: its lease is fenced and, with c2 open, the
  // step is held unknown at the whole hold. The sweep holds c2 unknown.
  await stopWorker(s, work.picked);
  await sweep(s);
  const writtenOff = await asPerson(
    s,
    writeOffBody({ taskId: work.taskId, attemptId: await attemptOf(s, first) }, 0),
  );
  appliedDetail(writtenOff, 'budget.write_off');

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
  return { work, versionId, first, c2, stopped, ...(await askOf(s, first)) };
}

describe.skipIf(serverUrl === undefined)('a top-up on a stop raised on a written-off hold', () => {
  it('refuses a top-up on a written-off hold whose call is still unknown, moving nothing, and lets the end apply', async () => {
    const { work, versionId, first, c2, stopped, runId, askId } = await stopOnWrittenOff();
    const before = await moneyOf(s, work, versionId);

    const topped = await topUp(s, work, first, 100);
    expect({
      stopped: codeOf(stopped),
      call: await callState(s, c2),
      code: codeOf(topped),
      answers: await answersOn(s, runId),
      money: await moneyOf(s, work, versionId),
      counted: await counted(s, first),
    }).toEqual({
      stopped: 'BUDGET_UNAVAILABLE',
      call: 'liability_unknown',
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
});

describe.skipIf(serverUrl === undefined)('a top-up after the written-off call settles late', () => {
  it("refuses the top-up's replacement for room once the written-off call settles late, the room counting the hold at its calls' 450 until #992, money unmoved", async () => {
    const { work, versionId, first, c2, stopped } = await stopOnWrittenOff();
    const before = await envelopeOf(s, work);
    await answerLate(s, work.picked, c2, priced(150));
    const settled = { call: await callState(s, c2), envelope: await envelopeOf(s, work) };
    const topped = await topUp(s, work, first, 100);
    // The top-up's fresh hold, picked up and stopped unspent. The room counts
    // the written-off hold at its calls (300 + 150), so 600 less 450 and
    // R1's 200 leaves none: the safe side, until #992 says what a write-off's
    // charge means for a call that prices later.
    const fresh = (await holdsOf(s, versionId)).find((hold) => hold.state === 'held');
    await stopWorker(s, await pickup(s, fresh?.id));
    const unmoved = await moneyOf(s, work, versionId);
    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: fresh?.id,
      leaseSeconds: 600,
    });
    const holds = await holdsOf(s, versionId);
    expect({
      stopped: codeOf(stopped),
      settled,
      topped: codeOf(topped),
      again: codeOf(again),
      live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
      committed: committed(holds),
      money: await moneyOf(s, work, versionId),
    }).toEqual({
      stopped: 'BUDGET_UNAVAILABLE',
      settled: { call: 'settled', envelope: before },
      topped: 'applied',
      again: 'BUDGET_UNAVAILABLE',
      live: [],
      committed: 500,
      money: unmoved,
    });
  });
});
