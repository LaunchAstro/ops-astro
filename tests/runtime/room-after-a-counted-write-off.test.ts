// SPDX-License-Identifier: AGPL-3.0-only
//
// A top-up on a held hold moves its calls' spend to date, an open call at its
// maximum, onto the envelope's actual. When a person later writes that hold
// off, its charge leaves the counted call out: the call's maximum lives in
// the envelope, not in the hold's actual. The version room must count the
// hold at every call the top-up counted, the written-off one too, so a
// replacement holds no more than the envelope has left.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  openSchedules,
  pickup,
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  callState,
  dispatchedCall,
  envelopeOf,
  holdsOf,
  roomyWork,
  spend,
  stampBefore,
  stopAndTopUp,
  stopWorker,
} from './version-room-world.ts';
import { answerLate, attemptOf, counted, priced } from './written-off-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/room-after-a-counted-write-off: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('counted_write_off_room', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await installBusinessSettings(tx);
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/**
 * The first hold ends unspent and its replacement R1 holds the whole 500. R1
 * spends 300 (c1) and sends c2 at 200, which answers above its hold: held
 * unknown, the step marked. The worker's authority goes, and the fence keeps
 * the marked step's hold whole. A stop on the held R1 and a top-up of 100 then
 * move c1 and c2's 200 to the envelope's actual, R1 held 100, and a person
 * writes R1 off at 0. The fence comes before the stop: a stop releases the
 * hold's lease, after which only a pickup could fence it, and a pickup refuses
 * a marked step before it fences.
 */
async function countedWriteOff() {
  const { work, versionId, first } = await roomyWork(s);
  await stopWorker(s, work.picked);
  const second = await pickup(s, first);
  const r1 = second['reservationId'];
  await spend(s, r1, 300);
  const c2 = await dispatchedCall(s, r1, 200);
  await answerLate(s, second, c2, priced(250));
  await stopWorker(s, second);
  // Seeded: the stop a worker's call raises finds its run claimed.
  await s.db.admin.execute(
    "update public.planned_runs set state = 'claimed' where id = (select run_id from public.reservations where id = $1)",
    [r1],
  );
  await stopAndTopUp(s, { ...work, picked: second }, r1, 100);
  appliedDetail(
    await asPerson(s, writeOffBody({ taskId: work.taskId, attemptId: await attemptOf(s, r1) }, 0)),
    'budget.write_off',
  );
  const closed = { call: await callState(s, c2), counted: await counted(s, r1) };
  return { work, versionId, first, r1, closed };
}

describe.skipIf(serverUrl === undefined)(
  'the version room after a counted hold is written off',
  () => {
    it('counts a hold topped up before a person wrote it off at the 500 the top-up moved, so the replacement holds the 100 left', async () => {
      const { work, versionId, first, r1, closed } = await countedWriteOff();
      // R1 stamped before the first hold, which reads as the newest and is
      // replaced on its whole 500 left: the room is 600 less R1's 500.
      await stampBefore(s, first, r1);
      await pickup(s, first);
      const holds = await holdsOf(s, versionId);
      const [envelope] = (await envelopeOf(s, work)) as readonly { actual: string }[];
      expect({
        closed,
        actual: envelope?.actual,
        live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
      }).toEqual({
        closed: { call: 'liability_unknown', counted: true },
        actual: '500',
        live: ['100'],
      });
    });
  },
);
