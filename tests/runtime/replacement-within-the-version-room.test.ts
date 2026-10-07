// SPDX-License-Identifier: AGPL-3.0-only
//
// A replacement hold is sized by what its old hold had left, and never past
// what the version has left of its approved ceiling. Rows written before
// replacements were stamped at insertion can carry a replacement whose
// created_at sorts before its predecessor's, so the predecessor reads as the
// newest hold. Picking it up must still keep the version inside its ceiling:
// its spend and every hold still live count against it, under the run lock.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  asAgent,
  capCommitted,
  codeOf,
  liveWork,
  openSchedules,
  pickup,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import {
  committed,
  envelopeOf,
  expireLease,
  holdsOf,
  moneyOf,
  roomyWork,
  spend,
  stampBefore,
  stopAndTopUp,
  stopWorker,
  topUp,
  unknownCall,
  type Hold,
} from './version-room-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/replacement-within-the-version-room: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('replacement_room', 1_000_000);
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

async function asksOf(runId: unknown): Promise<readonly unknown[]> {
  return await rows(
    s,
    'select reservation_id from public.budget_asks where business_id = $1 and run_id = $2',
    [s.business, runId],
  );
}

describe.skipIf(serverUrl === undefined)('a replacement holds within the version room', () => {
  it("holds only the version's remaining 300 when a replacement's timestamp sorts before its predecessor's, and the version never commits past its 500", async () => {
    const work = await liveWork(s, `replacement room ${randomUUID()}`, 500);
    const versionId = work.proposal['versionId'];
    const first = work.decision['reservationId'];
    await s.db.admin.execute(
      `update public.task_envelopes set maximum_minor = 1000
        where business_id = $1 and task_id = $2`,
      [s.business, work.taskId],
    );
    await spend(s, first, 100);
    await stopWorker(s, work.picked);
    const second = await pickup(s, first);
    await spend(s, second['reservationId'], 100);
    await stopWorker(s, second);
    // The historical state: the replacement stamped before its predecessor.
    await stampBefore(s, first, second['reservationId']);

    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    const holds = await holdsOf(s, versionId);
    const live = holds.filter((hold) => hold.state === 'held').map((hold) => hold.held);
    expect({ code: codeOf(again), live, committed: committed(holds) }).toEqual({
      code: 'applied',
      live: ['300'],
      committed: 500,
    });
  });
});

describe.skipIf(serverUrl === undefined)(
  'a replacement after a top-up holds within the version room',
  () => {
    it('counts the spend a top-up moved off a held hold, so a replacement sorted before it leaves the version at its approved 600', async () => {
      const { work, versionId, first } = await roomyWork(s);
      await spend(s, first, 100);
      // Stopped at its ceiling and topped up by 100: the hold stays held at
      // 500 + 100 - 100, and the 100 spent moves to the envelope's actual.
      await stopAndTopUp(s, work, first, 100);
      // The pickup after the top-up replaces the hold with one held at 500.
      const second = await pickup(s, first);
      await spend(s, second['reservationId'], 100);
      await stopWorker(s, second);
      await stampBefore(s, first, second['reservationId']);

      const again = await asAgent(s, {
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: first,
        leaseSeconds: 600,
      });
      const holds = await holdsOf(s, versionId);
      const live = holds.filter((hold) => hold.state === 'held').map((hold) => hold.held);
      // The spend the top-up moved to the envelope's actual: the first hold's calls.
      const [moved] = await rows<{ minor: string }>(
        s,
        `select coalesce(sum(actual_minor), 0)::text as minor from public.model_calls
        where business_id = $1 and reservation_id = $2 and state = 'settled'`,
        [s.business, first],
      );
      expect({
        code: codeOf(again),
        live,
        committed: Number(moved?.minor) + committed(holds),
      }).toEqual({
        code: 'applied',
        live: ['400'],
        committed: 600,
      });
    });
  },
);

describe.skipIf(serverUrl === undefined)('a replacement with no room left in its version', () => {
  it('stops the run at its budget and asks once when the version has no room left, moving no money', async () => {
    const { work, versionId, first } = await roomyWork(s);
    await spend(s, first, 100);
    await stopWorker(s, work.picked);
    const second = await pickup(s, first);
    await spend(s, second['reservationId'], 400);
    await stopWorker(s, second);
    await stampBefore(s, first, second['reservationId']);
    const [run] = await rows<{ run_id: string }>(
      s,
      'select run_id from public.reservations where business_id = $1 and id = $2',
      [s.business, first],
    );
    const before = await moneyOf(s, work, versionId);

    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    const asks = await rows(
      s,
      'select reservation_id from public.budget_asks where business_id = $1 and run_id = $2',
      [s.business, run?.run_id],
    );
    expect({ code: codeOf(again), asks, money: await moneyOf(s, work, versionId) }).toEqual({
      code: 'BUDGET_UNAVAILABLE',
      asks: [{ reservation_id: first }],
      money: before,
    });
    // Picked up again while the run waits: refused, with no second ask and no money moved.
    const retried = await claim(first);
    expect({
      code: codeOf(retried),
      asks: await asksOf(run?.run_id),
      money: await moneyOf(s, work, versionId),
    }).toEqual({ code: 'RESERVATION_NOT_CLAIMABLE', asks, money: before });
  });
});

describe.skipIf(serverUrl === undefined)(
  'a version-room replacement after a top-up with a call open',
  () => {
    it('counts a call still open at the top-up at its maximum, so a replacement sorted before it leaves the version at its approved 600', async () => {
      const { work, versionId, first } = await roomyWork(s);
      await spend(s, first, 100);
      // Sent and never settled: the top-up moves it at its maximum of 50.
      await unknownCall(s, first, 50);
      // Held at 500 + 100 - 150, and the 150 moved to the envelope's actual.
      await stopAndTopUp(s, work, first, 100);
      const second = await pickup(s, first);
      await spend(s, second['reservationId'], 300);
      await stopWorker(s, second);
      await stampBefore(s, first, second['reservationId']);

      const again = await claim(first);
      const holds = await holdsOf(s, versionId);
      const live = holds.filter((hold) => hold.state === 'held').map((hold) => hold.held);
      // What the top-up moved, as spentOn counts it: settled at actual, open at maximum.
      const [moved] = await rows<{ minor: string }>(
        s,
        `select coalesce(sum(case when state = 'settled' then actual_minor
                                when state in ('reserved', 'dispatched', 'liability_unknown')
                                  then reserved_minor else 0 end), 0)::text as minor
         from public.model_calls where business_id = $1 and reservation_id = $2`,
        [s.business, first],
      );
      expect({
        code: codeOf(again),
        live,
        committed: Number(moved?.minor) + committed(holds),
      }).toEqual({ code: 'applied', live: ['150'], committed: 600 });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'a top-up answering a no-room stop on an unspent hold',
  () => {
    it('tops up a run stopped for room on a hold its lease left unspent, holding the 100 with the money adding up', async () => {
      const { work, versionId, first } = await roomyWork(s);
      // The lease runs out with nothing spent; the pickup closes the hold at nothing.
      await expireLease(s, work.picked);
      const second = await pickup(s, first);
      await spend(s, second['reservationId'], 500);
      await stopWorker(s, second);
      await stampBefore(s, first, second['reservationId']);
      const stopped = await claim(first);
      const capBefore = await capCommitted(s);

      const topped = await topUp(s, work, first, 100);
      const holds: readonly Hold[] = await holdsOf(s, versionId);
      expect({
        stopped: codeOf(stopped),
        code: codeOf(topped),
        live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
        envelope: await envelopeOf(s, work),
        cap: (await capCommitted(s)) - capBefore,
      }).toEqual({
        stopped: 'BUDGET_UNAVAILABLE',
        code: 'applied',
        live: ['100'],
        envelope: [{ maximum: '1100', held: '100', actual: '500' }],
        cap: 100,
      });
    });
  },
);
