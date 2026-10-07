// SPDX-License-Identifier: AGPL-3.0-only
//
// A top-up on a held hold moves its calls' spend to date, an open call at its
// maximum, onto the envelope's actual. When a person later writes that hold
// off, its charge leaves the counted call out: the call's maximum lives in
// the envelope, not in the hold's actual. The version room must count the
// hold at every call the top-up counted, the written-off one too, so a
// replacement holds no more than the envelope has left.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileUnknown } from '../../packages/core-runtime/src/index.ts';
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
  asBeforeHoldState,
  callState,
  dispatchedCall,
  envelopeOf,
  holdStateOf,
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
 * writes R1 off at `charge` (0 unless given). The fence comes before the stop: a stop releases the
 * hold's lease, after which only a pickup could fence it, and a pickup refuses
 * a marked step before it fences.
 */
async function countedWriteOff(charge = 0, beforeWriteOff?: (r1: unknown) => Promise<void>) {
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
  await beforeWriteOff?.(r1);
  appliedDetail(
    await asPerson(
      s,
      writeOffBody({ taskId: work.taskId, attemptId: await attemptOf(s, r1) }, charge),
    ),
    'budget.write_off',
  );
  const closed = {
    call: await callState(s, c2),
    counted: await counted(s, r1),
    recorded: await holdStateOf(s, r1),
  };
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
        closed: { call: 'liability_unknown', counted: true, recorded: [{ hold_state: 'held' }] },
        actual: '500',
        live: ['100'],
      });
    });

    it('counts a hold topped up and then written off above zero at the moved calls and the charge, so no hold passes the raised ceiling', async () => {
      // The ceiling is 500 raised by 100: 600. The top-up moved R1's 500 to the
      // envelope's actual and the write-off charges 100 more, so R1 alone fills it.
      const { work, versionId, first, r1 } = await countedWriteOff(100);
      await stampBefore(s, first, r1);
      const again = await asAgent(s, {
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: first,
        leaseSeconds: 600,
      });
      const holds = await holdsOf(s, versionId);
      const [envelope] = (await envelopeOf(s, work)) as readonly { actual: string }[];
      expect({
        code: codeOf(again),
        actual: envelope?.actual,
        live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
      }).toEqual({ code: 'BUDGET_UNAVAILABLE', actual: '600', live: [] });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'the version room after an upgrade from before the hold state',
  () => {
    it('counts a hold topped up while held before the hold state, then written off above zero, at the moved calls and the charge', async () => {
      // Sol's SC1 Scenario: the top-up predates the column, so only the upgrade
      // can say the hold was still held when it answered.
      const { work, versionId, first, r1 } = await countedWriteOff(100);
      await stampBefore(s, first, r1);
      await asBeforeHoldState(s);
      const again = await asAgent(s, {
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: first,
        leaseSeconds: 600,
      });
      const holds = await holdsOf(s, versionId);
      const [envelope] = (await envelopeOf(s, work)) as readonly { actual: string }[];
      expect({
        code: codeOf(again),
        recorded: await holdStateOf(s, r1),
        actual: envelope?.actual,
        live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
      }).toEqual({
        code: 'BUDGET_UNAVAILABLE',
        recorded: [{ hold_state: 'held' }],
        actual: '600',
        live: [],
      });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'the version room after an upgrade, with a start stamp shared by another hold',
  () => {
    it('reads a top-up made while held as held, even when another hold on the run was reserved at its start stamp', async () => {
      // SEC-P2R18 L1: two transactions on one run started in the same microsecond.
      // The first hold's attempt (500, not the top-up's 100) shares the answer's stamp.
      const { work, versionId, first, r1 } = await countedWriteOff(100);
      await stampBefore(s, first, r1);
      const moved = await s.db.admin.execute(
        `update public.budget_answers a set answered_at = t.created_at
           from public.budget_asks k, public.attempts t
          where k.business_id = a.business_id and k.id = a.ask_id and a.kind = 'top_up'
            and a.business_id = $1 and k.reservation_id = $2
            and t.business_id = a.business_id and t.reservation_id = $3
          returning a.id`,
        [s.business, r1, first],
      );
      expect(moved, "the top-up's stamp now the first hold's").toHaveLength(1);
      await asBeforeHoldState(s);
      const again = await asAgent(s, {
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: first,
        leaseSeconds: 600,
      });
      const live = (await holdsOf(s, versionId)).filter((hold) => hold.state === 'held');
      expect({
        code: codeOf(again),
        recorded: await holdStateOf(s, r1),
        live: live.map((hold) => hold.held),
        envelope: await envelopeOf(s, work),
      }).toMatchObject({
        code: 'BUDGET_UNAVAILABLE',
        recorded: [{ hold_state: 'held' }],
        live: [],
      });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'the version room after an upgrade, with a replacement at the top-up step, amount and stamp',
  () => {
    it('reads a top-up made while held as held when a reconciled replacement at its step and amount shares its stamp, so the written-off charge fills the version', async () => {
      // Sol's SC2 Scenario: after the top-up, reconciliation proves R1's step
      // absent and reserves R2 at R1's 100 for the same step. R1 is written off
      // at 100 and R2 ends unspent. R2's attempt shares the answer's start stamp
      // (two transactions starting in one microsecond), so before the column
      // nothing tells the top-up from a closed-first one: it is read as held.
      const reconciled: { r2?: unknown } = {};
      const { work, versionId, r1 } = await countedWriteOff(100, async (held) => {
        await s.db.app.withBusiness(
          s.business,
          async (tx) => await reconcileUnknown(tx, async () => await Promise.resolve(false)),
        );
        const [r2] = await rows<{ id: string }>(
          s,
          `select r.id from public.reservations r
            where r.business_id = $1 and r.state = 'held' and r.id <> $2
              and r.run_id = (select run_id from public.reservations where id = $2)`,
          [s.business, held],
        );
        reconciled.r2 = r2?.id;
      });
      const r2 = reconciled.r2;
      await stopWorker(s, await pickup(s, r2));
      const moved = await s.db.admin.execute(
        `update public.budget_answers a set answered_at = t.created_at
           from public.budget_asks k, public.attempts t
          where k.business_id = a.business_id and k.id = a.ask_id and a.kind = 'top_up'
            and a.business_id = $1 and k.reservation_id = $2
            and t.business_id = a.business_id and t.reservation_id = $3
          returning a.id`,
        [s.business, r1, r2],
      );
      expect(moved, "the top-up's stamp now R2's").toHaveLength(1);
      const collides = await rows(
        s,
        `select 1 from public.attempts t, public.attempts u, public.budget_answers a, public.budget_asks k
          where t.business_id = $1 and t.reservation_id = $3 and u.business_id = $1 and u.reservation_id = $2
            and k.business_id = $1 and k.reservation_id = $2 and a.business_id = $1 and a.ask_id = k.id
            and a.kind = 'top_up' and t.state = 'abandoned' and t.step_id = u.step_id
            and t.estimated_minor = a.amount_minor and t.created_at = a.answered_at`,
        [s.business, r1, r2],
      );
      expect(
        collides,
        "R2's attempt: R1's step, the top-up's amount and stamp, ended unspent",
      ).toHaveLength(1);
      await asBeforeHoldState(s);
      const again = await asAgent(s, {
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: r2,
        leaseSeconds: 600,
      });
      const holds = await holdsOf(s, versionId);
      const [envelope] = (await envelopeOf(s, work)) as readonly { actual: string }[];
      expect({
        code: codeOf(again),
        recorded: await holdStateOf(s, r1),
        actual: envelope?.actual,
        live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
      }).toEqual({
        code: 'BUDGET_UNAVAILABLE',
        recorded: [{ hold_state: 'held' }],
        actual: '600',
        live: [],
      });
    });
  },
);
