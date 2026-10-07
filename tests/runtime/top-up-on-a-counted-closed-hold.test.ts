// SPDX-License-Identifier: AGPL-3.0-only
//
// A hold topped up while still held counted its open call at its maximum.
// When the pickup later closes that hold and a stop for room lands on it, the
// call is still open but nobody closed it: no write-off or outcome left it
// there. The top-up on that stop applies as any other on a closed hold does,
// a fresh hold of the amount on the envelope raised by it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  asAgent,
  codeOf,
  openSchedules,
  pickup,
  rows,
  type Schedules,
  type Work,
} from './schedules-harness.ts';
import {
  callState,
  dispatchedCall,
  holdsOf,
  roomyWork,
  spend,
  stampBefore,
  stopAndTopUp,
  stopWorker,
  topUp,
} from './version-room-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/top-up-on-a-counted-closed-hold: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('counted_closed_stop', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await installBusinessSettings(tx);
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The envelope's approved maximum. */
async function maximumOf(work: Work): Promise<number> {
  const [envelope] = await rows<{ maximum: string }>(
    s,
    `select maximum_minor::text as maximum from public.task_envelopes
      where business_id = $1 and task_id = $2`,
    [s.business, work.taskId],
  );
  return Number(envelope?.maximum);
}

describe.skipIf(serverUrl === undefined)(
  'a top-up on a stop raised on a counted closed hold',
  () => {
    it('tops up a closed hold whose open call a top-up counted and no person closed, holding the 100 on the envelope raised by it', async () => {
      const { work, versionId, first } = await roomyWork(s);
      // Sent at 400 and never answered; a call over the ceiling stops the run,
      // and the top-up of 100 counts c1 at its maximum: held 200, actual +400.
      const c1 = await dispatchedCall(s, first, 400);
      await stopAndTopUp(s, work, first, 100);
      // The pickup fences the first hold and holds the 200 left; the
      // replacement spends it, stops, and is stamped before the first hold.
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
      const before = await maximumOf(work);

      const topped = await topUp(s, work, first, 100);
      expect({
        stopped: codeOf(stopped),
        call: await callState(s, c1),
        code: codeOf(topped),
        raised: (await maximumOf(work)) - before,
        live: (await holdsOf(s, versionId)).filter((h) => h.state === 'held').map((h) => h.held),
      }).toEqual({
        stopped: 'BUDGET_UNAVAILABLE',
        call: 'dispatched',
        code: 'applied',
        raised: 100,
        live: ['100'],
      });
    });
  },
);
