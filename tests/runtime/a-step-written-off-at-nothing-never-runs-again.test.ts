// SPDX-License-Identifier: AGPL-3.0-only
//
// #2277: a person who writes a step off at nothing (`amountMinor: 0`) says it
// cost nothing, not that nothing happened. Its call was sent and never
// answered, so the step's effect is unknown, as after any write-off: the
// attempt records outcome `unknown`, the hold closes as a write-off closes it,
// and a pickup of that hold is refused, so the step never runs again and no
// money moves. A person's `nothing_happened` outcome still lets the step run
// again on a fresh hold.

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
import { holdOf, writeOffBody } from './t3c-harness.ts';
import {
  dispatchedCall,
  holdsOf,
  moneyOf,
  roomyWork,
  spend,
  stopWorker,
  sweep,
} from './version-room-world.ts';
import { attemptOf } from './written-off-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/a-step-written-off-at-nothing-never-runs-again: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('zero_write_off', 1_000_000);
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
 * Live work on a 500 hold that spent `spent` and sent a call of 200 that never
 * answered. The worker's authority goes and the sweep holds the call unknown,
 * so the step is held as an unknown liability at the whole hold.
 */
async function heldUnknown(spent: number) {
  const { work, versionId, first } = await roomyWork(s);
  if (spent > 0) await spend(s, first, spent);
  await dispatchedCall(s, first, 200);
  await stopWorker(s, work.picked);
  await sweep(s);
  const attemptId = await attemptOf(s, first);
  expect(await holdOf(s, { attemptId })).toMatchObject({
    attempt_state: 'liability_unknown',
    reservation_state: 'held',
  });
  return { work, versionId, first, attemptId };
}

async function pickupOf(reservationId: unknown) {
  return await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId,
    leaseSeconds: 600,
  });
}

/**
 * The step held unknown after spending `spent`, written off at 0, then a
 * pickup of its hold: what the write-off left, the pickup's answer, the holds
 * still held, and the money as the write-off left it and after the pickup.
 */
async function writtenOffThenPickedUp(spent: number) {
  const { work, versionId, first, attemptId } = await heldUnknown(spent);
  appliedDetail(
    await asPerson(s, writeOffBody({ taskId: work.taskId, attemptId }, 0)),
    'budget.write_off',
  );
  const money = await moneyOf(s, work, versionId);
  const picked = await pickupOf(first);
  const seen = {
    hold: await holdOf(s, { attemptId }),
    picked: codeOf(picked),
    held: (await holdsOf(s, versionId)).filter((hold) => hold.state === 'held'),
    money: await moneyOf(s, work, versionId),
  };
  return { seen, money };
}

const unknownAbandoned = { attempt_state: 'abandoned', outcome: 'unknown', attempt_actual: null };
const refused = { picked: 'RESERVATION_NOT_CLAIMABLE', held: [] };

describe.skipIf(serverUrl === undefined)('a step written off at nothing', () => {
  it('records the effect as unknown, closes the unspent hold under the write-off, and refuses a pickup with nothing moved', async () => {
    const { seen, money } = await writtenOffThenPickedUp(0);
    expect(seen).toEqual({
      hold: {
        ...unknownAbandoned,
        reservation_state: 'abandoned',
        reservation_actual: null,
        classified_cause: 'written_off',
        envelope_held: '0',
        envelope_actual: '0',
      },
      ...refused,
      money,
    });
  });

  it('records the effect as unknown, settles the hold at what its calls spent, and refuses a pickup with nothing moved', async () => {
    const { seen, money } = await writtenOffThenPickedUp(300);
    expect(seen).toEqual({
      hold: {
        ...unknownAbandoned,
        reservation_state: 'actual',
        reservation_actual: '300',
        classified_cause: null,
        envelope_held: '0',
        envelope_actual: '300',
      },
      ...refused,
      money,
    });
  });
});

describe.skipIf(serverUrl === undefined)('a step a person says nothing happened on', () => {
  it('runs again on a fresh hold once a person records nothing_happened', async () => {
    const { work, versionId, attemptId } = await heldUnknown(300);
    appliedDetail(
      await asPerson(s, {
        command: 'budget.record_outcome',
        operationId: randomUUID(),
        recordId: work.taskId,
        attemptId,
        outcome: 'nothing_happened',
      }),
      'budget.record_outcome',
    );

    // The outcome resumes the step on a fresh hold of what is left, and a pickup runs it.
    const fresh = (await holdsOf(s, versionId)).filter((hold) => hold.state === 'held');
    const picked = await pickupOf(fresh[0]?.id);
    expect({
      outcome: (await holdOf(s, { attemptId }))?.['outcome'],
      fresh: fresh.map((hold) => hold.held),
      picked: codeOf(picked),
    }).toEqual({ outcome: 'abandoned', fresh: ['200'], picked: 'applied' });
  });
});
