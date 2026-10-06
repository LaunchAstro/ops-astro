// SPDX-License-Identifier: AGPL-3.0-only
//
// A call the broker reserved and never sent, left on a hold whose lease ended,
// was never counted: the classifier closes the hold at its settled calls, and
// only the sweep releases the call, with nothing to give back. The version room
// counts that hold at its settled calls, so its pickup is not stopped for room.
// A top-up answering a stop raised on such a closed hold releases the call
// uncounted first, so the sweep never gives back money no count took.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { asAgent, codeOf, openSchedules, pickup, type Schedules } from './schedules-harness.ts';
import {
  callState,
  envelopeOf,
  expireLease,
  forgetHoldState,
  holdStateOf,
  holdsOf,
  roomyWork,
  spend,
  stampBefore,
  stopWorker,
  sweep,
  topUp,
  unsentCall,
} from './version-room-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/unsent-call-on-a-closed-hold: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('unsent_closed_hold', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await installBusinessSettings(tx);
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** An agent picks the hold up. */
async function claim(reservationId: unknown): Promise<Awaited<ReturnType<typeof asAgent>>> {
  return await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId,
    leaseSeconds: 600,
  });
}

async function liveOf(versionId: unknown): Promise<readonly string[]> {
  return (await holdsOf(s, versionId))
    .filter((hold) => hold.state === 'held')
    .map((hold) => hold.held);
}

/**
 * The no-room stop on the first hold, closed by its ended lease with `unsent`
 * still reserved on it: the replacement spends `spent`, stops, and is stamped
 * before the first hold, so picking the first hold up finds the version full.
 */
async function stopForRoom(
  work: Awaited<ReturnType<typeof roomyWork>>['work'],
  first: unknown,
  spent: number,
): Promise<string | undefined> {
  await expireLease(s, work.picked);
  const second = await pickup(s, first);
  await spend(s, second['reservationId'], spent);
  await stopWorker(s, second);
  await stampBefore(s, first, second['reservationId']);
  return codeOf(await claim(first));
}

describe.skipIf(serverUrl === undefined)('a pickup after a lease left a call unsent', () => {
  it("holds the 200 the version has left when the hold's lease ended with a call reserved and never sent", async () => {
    const { work, versionId, first } = await roomyWork(s);
    await spend(s, first, 300);
    await unsentCall(s, first, 200);
    await expireLease(s, work.picked);

    const again = await claim(first);
    expect({ code: codeOf(again), live: await liveOf(versionId) }).toEqual({
      code: 'applied',
      live: ['200'],
    });
  });
});

describe.skipIf(serverUrl === undefined)('a top-up on a closed hold with a call unsent', () => {
  it('releases the unsent call uncounted when a top-up answers a no-room stop on a hold closed at its spend, so the sweep gives nothing back', async () => {
    const { work, first } = await roomyWork(s);
    await spend(s, first, 300);
    const unsent = await unsentCall(s, first, 200);
    const stopped = await stopForRoom(work, first, 200);
    const topped = await topUp(s, work, first, 100);
    const answered = await envelopeOf(s, work);

    await sweep(s);
    expect({
      stopped,
      code: codeOf(topped),
      answered,
      swept: await envelopeOf(s, work),
      call: await callState(s, unsent),
    }).toEqual({
      stopped: 'BUDGET_UNAVAILABLE',
      code: 'applied',
      answered: [{ maximum: '1100', held: '100', actual: '500' }],
      swept: [{ maximum: '1100', held: '100', actual: '500' }],
      call: 'released',
    });
  });
});

describe.skipIf(serverUrl === undefined)('a pickup after a top-up on a closed hold', () => {
  it('counts the closed hold once, at the spend it closed at, so the topped-up step is held again for what it has left', async () => {
    // Approved 500, raised to 600. The first hold closed at 300 with 200 unsent,
    // the second at 200, and the top-up's hold spends 40 and stops: 540 spent.
    const { work, versionId, first } = await roomyWork(s);
    await spend(s, first, 300);
    await unsentCall(s, first, 200);
    expect(await stopForRoom(work, first, 200)).toBe('BUDGET_UNAVAILABLE');
    expect(codeOf(await topUp(s, work, first, 100))).toBe('applied');
    const fresh = (await holdsOf(s, versionId)).find((hold) => hold.state === 'held');
    const third = await pickup(s, fresh?.id);
    await spend(s, third['reservationId'], 40);
    await stopWorker(s, third);

    const again = await claim(fresh?.id);
    expect({
      code: codeOf(again),
      live: await liveOf(versionId),
      recorded: await holdStateOf(s, first),
    }).toEqual({ code: 'applied', live: ['60'], recorded: [{ hold_state: 'actual' }] });
  });
});

describe.skipIf(serverUrl === undefined)('a pickup after a top-up on a causeless hold', () => {
  it('counts a hold the classifier closed before it recorded a cause once, so the topped-up step is held again for what it has left', async () => {
    // As above, but the first hold keeps no cause, as one the classifier settled
    // before 20261004040100 does: the upgrade leaves such a row as it was.
    const { work, versionId, first } = await roomyWork(s);
    await spend(s, first, 300);
    await unsentCall(s, first, 200);
    expect(await stopForRoom(work, first, 200)).toBe('BUDGET_UNAVAILABLE');
    const legacy = await s.db.admin.execute(
      `update public.reservations set classified_cause = null, classified_cause_id = null
        where business_id = $1 and id = $2 and state = 'actual'
        returning id`,
      [s.business, first],
    );
    expect(legacy, 'the first hold closed actual, its cause now dropped').toHaveLength(1);
    expect(codeOf(await topUp(s, work, first, 100))).toBe('applied');
    const fresh = (await holdsOf(s, versionId)).find((hold) => hold.state === 'held');
    const third = await pickup(s, fresh?.id);
    await spend(s, third['reservationId'], 40);
    await stopWorker(s, third);

    const again = await claim(fresh?.id);
    expect({ code: codeOf(again), live: await liveOf(versionId) }).toEqual({
      code: 'applied',
      live: ['60'],
    });
  });

  it('counts a closed hold once when its top-up was written before the answer recorded the hold state', async () => {
    // As above, the top-up's hold_state also null, as a top-up written before
    // the column was: the room counts it closed first, at the greater.
    const { work, versionId, first } = await roomyWork(s);
    await spend(s, first, 300);
    await unsentCall(s, first, 200);
    expect(await stopForRoom(work, first, 200)).toBe('BUDGET_UNAVAILABLE');
    await s.db.admin.execute(
      `update public.reservations set classified_cause = null, classified_cause_id = null
        where business_id = $1 and id = $2 and state = 'actual'`,
      [s.business, first],
    );
    expect(codeOf(await topUp(s, work, first, 100))).toBe('applied');
    expect(await forgetHoldState(s, first), 'the top-up row, its state dropped').toHaveLength(1);
    const fresh = (await holdsOf(s, versionId)).find((hold) => hold.state === 'held');
    const third = await pickup(s, fresh?.id);
    await spend(s, third['reservationId'], 40);
    await stopWorker(s, third);

    const again = await claim(fresh?.id);
    expect({ code: codeOf(again), live: await liveOf(versionId) }).toEqual({
      code: 'applied',
      live: ['60'],
    });
  });
});

describe.skipIf(serverUrl === undefined)('a top-up on an abandoned hold with a call unsent', () => {
  it('releases the unsent call uncounted when a top-up answers a no-room stop on a hold its lease left unspent, so the sweep gives nothing back', async () => {
    const { work, first } = await roomyWork(s);
    const unsent = await unsentCall(s, first, 500);
    const stopped = await stopForRoom(work, first, 500);
    const topped = await topUp(s, work, first, 100);
    const answered = await envelopeOf(s, work);

    await sweep(s);
    expect({
      stopped,
      code: codeOf(topped),
      answered,
      swept: await envelopeOf(s, work),
      call: await callState(s, unsent),
      recorded: await holdStateOf(s, first),
    }).toEqual({
      stopped: 'BUDGET_UNAVAILABLE',
      code: 'applied',
      answered: [{ maximum: '1100', held: '100', actual: '500' }],
      swept: [{ maximum: '1100', held: '100', actual: '500' }],
      call: 'released',
      recorded: [{ hold_state: 'abandoned' }],
    });
  });
});
