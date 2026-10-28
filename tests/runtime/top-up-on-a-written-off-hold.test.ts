// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's write-off closes a hold whose call was sent and never answered:
// the call stays unknown, its outcome recorded, and nothing resolves it again.
// A write-off at 0 leaves the step's effect unknown as any write-off does
// (#2277), so a pickup of that closed hold is refused and the step never runs
// again: no replacement holds what is left, no stop is raised on the hold for
// a top-up to answer, and a late settle of the call moves no money.

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
  stopWorker,
  sweep,
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
 * unknown, so it closes at its settled 300 with the call still open and the
 * step's effect unknown (#2277). The pickup that would hold the 200 left and
 * stop the run for room on the first hold is refused: the step never runs
 * again, so no stop is raised on the written-off hold for a top-up to answer.
 */
async function pickedUpAfterWriteOff() {
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
  const before = await moneyOf(s, work, versionId);

  const picked = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: first,
    leaseSeconds: 600,
  });
  return { work, versionId, first, c2, picked, before, ...(await askOf(s, first)) };
}

describe.skipIf(serverUrl === undefined)('a pickup of a written-off hold', () => {
  it('refuses a pickup of a hold written off at 0 whose call is still unknown, moving nothing and raising no stop to top up', async () => {
    const { work, versionId, first, c2, picked, before, runId, askId } =
      await pickedUpAfterWriteOff();
    expect({
      picked: codeOf(picked),
      call: await callState(s, c2),
      ask: askId,
      answers: await answersOn(s, runId),
      money: await moneyOf(s, work, versionId),
      counted: await counted(s, first),
    }).toEqual({
      picked: 'RESERVATION_NOT_CLAIMABLE',
      call: 'liability_unknown',
      ask: undefined,
      answers: 0,
      money: before,
      counted: false,
    });
  });
});

describe.skipIf(serverUrl === undefined)('a pickup after the written-off call settles late', () => {
  it('refuses a pickup of the written-off hold once its call settles late, the version committing only its 300, money unmoved', async () => {
    const { work, versionId, first, c2, picked } = await pickedUpAfterWriteOff();
    const before = await envelopeOf(s, work);
    await answerLate(s, work.picked, c2, priced(150));
    const settled = { call: await callState(s, c2), envelope: await envelopeOf(s, work) };
    const unmoved = await moneyOf(s, work, versionId);
    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    const holds = await holdsOf(s, versionId);
    expect({
      picked: codeOf(picked),
      settled,
      again: codeOf(again),
      live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
      committed: committed(holds),
      money: await moneyOf(s, work, versionId),
    }).toEqual({
      picked: 'RESERVATION_NOT_CLAIMABLE',
      settled: { call: 'settled', envelope: before },
      again: 'RESERVATION_NOT_CLAIMABLE',
      live: [],
      committed: 300,
      money: unmoved,
    });
  });
});
