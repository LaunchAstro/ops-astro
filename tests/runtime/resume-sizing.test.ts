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
  codeOf,
  handbackBody,
  liveWork,
  pickup,
  rows,
  type Work,
} from './schedules-harness.ts';
import { openBilling } from './t3d1-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';
import { asksOn, holdsOn, pickupOf, revoke, spentWhole } from './resume-sizing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('resize');

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
  const work = await spentWhole('whole');

  const refused = await pickupOf(work);

  expect(codeOf(refused)).toBe('BUDGET_UNAVAILABLE');
  const asks = await asksOn(work);
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

it('a claimant without authority at a spent-whole hold is refused, and no ask is raised', async () => {
  const work = await spentWhole('unauthorised');
  // The approver's write lapses: the agent's pickup on their approval would widen it.
  const lapsed = await rows<{ id: string }>(
    s,
    `update public.grants set expires_at = clock_timestamp()
      where subject_id = $1 and action = 'write' and expires_at is null returning id`,
    [s.decider.personId],
  );
  try {
    const refused = await pickupOf(work);

    expect(codeOf(refused)).toBe('DELEGATION_WIDENS');
    expect(await asksOn(work)).toEqual([]);
    expect((await holdsOn(work)).map((one) => one.state)).toEqual(['actual']);
  } finally {
    await rows(s, 'update public.grants set expires_at = null where id = any($1::uuid[])', [
      lapsed.map((one) => one.id),
    ]);
  }
});
