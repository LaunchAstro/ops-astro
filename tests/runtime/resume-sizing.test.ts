// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-29 FIXMONEY (MONEY's left finding): a hold the classifier settled at
// its broker calls' spend is history, and the step's work comes back on a
// fresh hold. That hold is the old one less what its calls already spent: the
// step's budget that remains, which the envelope has room for. When the spend
// used the whole hold, nothing is left to hold: the run stops at its budget
// and asks a person (AW-05), the same ask a run reaching its ceiling raises,
// never a refusal nothing answers. Driven through the real pickup, hand-back
// and budget answer.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  handbackBody,
  liveWork,
  pickup,
  rows,
  type Work,
} from './schedules-harness.ts';
import { grantTo } from '../commands/fixture.ts';
import { openBilling } from './t3d1-harness.ts';
import { broker, call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('resize');

interface Hold {
  readonly id: string;
  readonly state: string;
  readonly held: string;
  readonly actual: string | null;
}

const holdsOn = async (work: Work): Promise<readonly Hold[]> =>
  await rows<Hold>(
    s,
    `select r.id, r.state, r.held_minor::text as held, r.actual_minor::text as actual
       from public.reservations r
       join public.reservations old on old.run_id = r.run_id
      where old.id = $1 order by r.created_at, r.id`,
    [work.decision['reservationId']],
  );

const spentOn = async (work: Work): Promise<number> => {
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
  const work = await liveWork(s, `resize ${label} ${randomUUID()}`, 2_000);
  world.provider.mode('answer');
  const result = await call(work);
  if (!result.ok) throw new Error(`the priced replay call was refused ${result.code}`);
  return work;
};

/** A manager revokes the worker's delegation: its hold is classified and its run goes back to planned. */
const revoke = async (work: Work): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));
  const revoked = await asPerson(s, {
    command: 'delegation.revoke',
    operationId: randomUUID(),
    delegationId: work.picked['delegationId'],
  });
  appliedDetail(revoked, 'delegation.revoke');
};

/** The decider tops up the work's stopped run, as a person with `billing:decide`. */
const topUp = async (work: Work, amountMinor: number): ReturnType<typeof topUpAtBudgetStop> => {
  await openBilling(s);
  const [run] = await rows<{ id: string }>(
    s,
    'select run_id as id from public.reservations where id = $1',
    [work.decision['reservationId']],
  );
  const { personId, actorId } = s.decider;
  return await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        runId: String(run?.id),
        caller: { kind: 'person', personId, actorId },
        subjects: [
          { kind: 'person', id: personId },
          { kind: 'actor', id: actorId },
        ],
        amountMinor,
        currency: 'AUD',
      }),
  );
};

it('a resumed step after a hold settled at its spend is re-held at the hold less the spend', async () => {
  const work = await settledCall('pickup');
  const spent = await spentOn(work);
  expect(spent).toBeGreaterThan(0);
  await revoke(work);

  const again = await pickup(s, work.decision['reservationId']);

  const [old, fresh] = await holdsOn(work);
  expect(old).toMatchObject({ state: 'actual', held: '2000', actual: String(spent) });
  expect(fresh).toMatchObject({ id: again['reservationId'], held: String(2_000 - spent) });
});

it('a dropped step resumed after its hold settled at its spend is re-held at the hold less the spend', async () => {
  const work = await settledCall('dropped');
  const spent = await spentOn(work);
  const body = {
    ...handbackBody(work.picked),
    outcome: 'dropped',
    report: { summary: 'the connection went', dropCause: 'connection_lost' },
  };

  appliedDetail(await asAgent(s, body, String(work.picked['credential'])), 'task.handback');

  const [old, resumed] = await holdsOn(work);
  expect(old).toMatchObject({ state: 'actual', actual: String(spent) });
  expect(resumed).toMatchObject({ state: 'held', held: String(2_000 - spent) });
});

it('a hold with no spend is re-held whole, as before', async () => {
  const work = await liveWork(s, `resize none ${randomUUID()}`, 2_000);
  await revoke(work);

  await pickup(s, work.decision['reservationId']);

  const [old, fresh] = await holdsOn(work);
  expect(old).toMatchObject({ state: 'abandoned', actual: null });
  expect(fresh).toMatchObject({ state: 'held', held: '2000' });
});

it('a step whose spend used its whole hold stops at its budget and asks the person (AW-05), with no silent refusal', async () => {
  // The replay operation's priced maximum is 500: one call open at it spends the whole hold.
  const work = await liveWork(s, `resize whole ${randomUUID()}`, 500);
  const silent = {
    ...broker,
    custody: { ...broker.custody, dispatch: async () => await new Promise<never>(() => {}) },
  };
  void call(work, {}, silent);
  const openCall = async () =>
    await rows<{ state: string }>(
      s,
      'select state from public.model_calls where reservation_id = $1',
      [work.decision['reservationId']],
    );
  await expect.poll(openCall, { timeout: 5_000 }).toMatchObject([{ state: 'dispatched' }]);
  await revoke(work);

  const refused = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: work.decision['reservationId'],
    leaseSeconds: 600,
  });

  expect(codeOf(refused)).toBe('BUDGET_UNAVAILABLE');
  const asks = await rows<{ run_state: string; ceiling: string; spent: string; kind: string }>(
    s,
    `select run.state as run_state, k.ceiling_minor::text as ceiling, k.spent_minor::text as spent,
            k.kind
       from public.budget_asks k join public.planned_runs run on run.id = k.run_id
      where k.reservation_id = $1`,
    [work.decision['reservationId']],
  );
  expect(asks).toEqual([
    { run_state: 'waiting_budget', ceiling: '500', spent: '500', kind: 'stop' },
  ]);
  expect((await holdsOn(work)).map((one) => one.state)).toEqual(['actual']);

  // The person's answer is the one way on: a top-up holds what it raised.
  expect(await topUp(work, 300)).toMatchObject({
    ok: true,
    value: { state: 'applied', heldMinor: 300 },
  });
  const [, topped] = await holdsOn(work);
  await pickup(s, topped?.id);
  expect(await holdsOn(work)).toMatchObject([{ state: 'actual' }, { state: 'held', held: '300' }]);
});
