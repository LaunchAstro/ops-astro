// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-29 MONEY: a hold whose work stopped is never abandoned "at no cost"
// while the broker's calls under it spent. The classifier's abandon step reads
// the reservation's calls (`spentOn`): settled calls at their actual, calls
// still open at the maximum they hold. Above zero it settles the hold at that
// spend, so the envelope and the cap count it once; at zero it abandons as
// before. Either way the row records the cause that stopped it (0219). Each path that reaches the step is driven through the real process:
// the sweep the API runs, a person's cancel, and a dropped hand-back.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { sweepLostWorkers } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  handbackBody,
  liveWork,
  pickup,
  rows,
  type Work,
} from './schedules-harness.ts';
import { grantTo } from '../commands/fixture.ts';
import { room } from '../broker/aw-10-world.ts';
import { openBilling } from './t3d1-harness.ts';
import { broker, call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('mospend');

interface Money {
  readonly state: string;
  readonly actual: string | null;
  readonly cause: string | null;
  readonly cause_id: string | null;
  readonly envelope_held: string;
  readonly envelope_actual: string;
  /** What the envelope's held reservations hold, so a resumed hold beside the old one is counted. */
  readonly still_held: string;
}

const moneyOf = async (work: Work): Promise<Money> => {
  const [row] = await rows<Money>(
    s,
    `select r.state, r.actual_minor::text as actual, r.classified_cause as cause,
            r.classified_cause_id::text as cause_id,
            e.held_minor::text as envelope_held, e.actual_minor::text as envelope_actual,
            (select coalesce(sum(o.held_minor), 0) from public.reservations o
              where o.business_id = r.business_id and o.envelope_id = r.envelope_id
                and o.state = 'held')::text as still_held
       from public.reservations r
       join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
      where r.id = $1`,
    [work.decision['reservationId']],
  );
  if (row === undefined) throw new Error('no reservation for the work');
  return row;
};

/** The calls' spend as the broker counts it: settled at actual, open at their maximum. */
const callsSpent = async (work: Work): Promise<number> => {
  const [row] = await rows<{ spent: string }>(
    s,
    `select coalesce(sum(case when state = 'settled' then actual_minor
                              when state in ('reserved', 'dispatched') then reserved_minor
                              else 0 end), 0)::text as spent
       from public.model_calls where reservation_id = $1`,
    [work.decision['reservationId']],
  );
  return Number(row?.spent ?? 0);
};

const settledCall = async (label: string): Promise<Work> => {
  const work = await liveWork(s, `mospend ${label} ${randomUUID()}`, 2_000);
  world.provider.mode('answer');
  const result = await call(work);
  if (!result.ok) throw new Error(`the priced replay call was refused ${result.code}`);
  return work;
};

const expire = async (work: Work): Promise<void> => {
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [work.picked['leaseId']],
  );
};

/** A person cancels the work's lineage: its lease is retired and its hold classified. */
const cancel = async (work: Work): ReturnType<typeof asPerson> =>
  await asPerson(s, {
    command: 'task.cancel',
    operationId: randomUUID(),
    recordId: work.taskId,
    lineageId: work.proposal['lineageId'],
    reason: 'the client withdrew the request',
  });

const sweep = async (): ReturnType<typeof sweepLostWorkers> =>
  await s.db.app.withBusiness(s.business, async (tx) => await sweepLostWorkers(tx));

/**
 * The hold settled at the calls' spend, under the cause that stopped it: the
 * envelope gave back the hold and took the spend.
 */
const expectCounted = (before: Money, after: Money, spent: number, cause: string): void => {
  expect(spent).toBeGreaterThan(0);
  expect(after).toMatchObject({ state: 'actual', actual: String(spent), cause });
  expect(Number(after.envelope_actual)).toBe(Number(before.envelope_actual) + spent);
  expect(after.envelope_held).toBe(after.still_held);
};

it("a swept lease's settled model call is counted, not abandoned at no cost", async () => {
  const work = await settledCall('swept');
  const spent = await callsSpent(work);
  const before = await moneyOf(work);
  await expire(work);

  const swept = await sweep();

  const mine = swept.filter((one) => one.reservationId === work.decision['reservationId']);
  expect(mine).toMatchObject([{ released: true, state: 'actual' }]);
  expectCounted(before, await moneyOf(work), spent, 'lease_expired_and_fenced');
});

it('a swept hold settled at its spend records lease_expired_and_fenced', async () => {
  const work = await settledCall('cause');
  await expire(work);

  await sweep();

  expect(await moneyOf(work)).toMatchObject({
    state: 'actual',
    cause: 'lease_expired_and_fenced',
    cause_id: String(work.picked['leaseId']),
  });
});

it("a lineage cancel counts the calls' spend", async () => {
  const work = await settledCall('cancel');
  const spent = await callsSpent(work);
  const before = await moneyOf(work);

  appliedDetail(await cancel(work), 'task.cancel');
  expectCounted(before, await moneyOf(work), spent, 'lineage_cancelled');
});

it("a dropped hand-back counts the calls' spend", async () => {
  const work = await settledCall('dropped');
  const spent = await callsSpent(work);
  const before = await moneyOf(work);
  const body = {
    ...handbackBody(work.picked),
    outcome: 'dropped',
    report: { summary: 'the connection went', dropCause: 'connection_lost' },
  };

  const handed = appliedDetail(
    await asAgent(s, body, String(work.picked['credential'])),
    'task.handback',
  );

  expect(handed['reservationState']).toBe('actual');
  expectCounted(before, await moneyOf(work), spent, 'handback_completed');
  const [attempt] = await rows<{ state: string }>(
    s,
    'select state from public.attempts where reservation_id = $1',
    [work.decision['reservationId']],
  );
  expect(attempt?.state, 'the drop is recorded on the stopped attempt').toBe('dropped');
});

it('a hold with no calls is abandoned at zero, as before', async () => {
  const work = await liveWork(s, `mospend none ${randomUUID()}`, 2_000);
  const before = await moneyOf(work);
  await expire(work);

  const swept = await sweep();

  const mine = swept.filter((one) => one.reservationId === work.decision['reservationId']);
  expect(mine).toMatchObject([{ released: true, state: 'abandoned' }]);
  const after = await moneyOf(work);
  expect(after).toMatchObject({
    state: 'abandoned',
    actual: null,
    cause: 'lease_expired_and_fenced',
  });
  expect(after.envelope_actual).toBe(before.envelope_actual);
  expect(after.envelope_held).toBe(after.still_held);
});

it('a call still open at the stop is counted at its maximum', async () => {
  const work = await liveWork(s, `mospend open ${randomUUID()}`, 2_000);
  const silent = {
    ...broker,
    custody: { ...broker.custody, dispatch: async () => await new Promise<never>(() => {}) },
  };
  // Custody took the call and never answers: the call stays dispatched, its step unmarked.
  // (The sweep holds such a call unknown with its step marked; a cancel reads it as it stands.)
  void call(work, {}, silent);
  const openCall = async () =>
    await rows<{ state: string; reserved: string }>(
      s,
      `select state, reserved_minor::text as reserved from public.model_calls
        where reservation_id = $1`,
      [work.decision['reservationId']],
    );
  await expect.poll(openCall, { timeout: 5_000 }).toMatchObject([{ state: 'dispatched' }]);
  const [open] = await openCall();
  const before = await moneyOf(work);

  appliedDetail(await cancel(work), 'task.cancel');

  expectCounted(before, await moneyOf(work), Number(open?.reserved), 'lineage_cancelled');
});

it('work whose authority was lost after it spent is counted, and picked up again on a fresh hold', async () => {
  const work = await settledCall('revoked');
  const spent = await callsSpent(work);
  const before = await moneyOf(work);
  // A manager of the work: `delegation.revoke` asks `manage` beside each delegated action.
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));

  const revoked = await asPerson(s, {
    command: 'delegation.revoke',
    operationId: randomUUID(),
    delegationId: work.picked['delegationId'],
  });

  appliedDetail(revoked, 'delegation.revoke');
  expectCounted(before, await moneyOf(work), spent, 'authority_revoked');
  // The run went back to planned (R5): the spent hold is history, and the work
  // gets a new one, which must find room beside the spend.
  await openBilling(s);
  await room(s, work);
  const again = await pickup(s, work.decision['reservationId']);
  expect(again['reservationId']).not.toBe(work.decision['reservationId']);
  expect((await moneyOf(work)).envelope_actual).toBe(
    String(Number(before.envelope_actual) + spent),
  );
});
