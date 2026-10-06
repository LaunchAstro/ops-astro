// SPDX-License-Identifier: AGPL-3.0-only
//
// The end with no askId answers the run's open ask. It finds the ask's hold
// before its locks; if, in that gap, ask 1 is topped up, its replacement is
// picked up and the run stops again at ask 2, the hold it found is ask 1's.
// Ending the run then must not leave ask 2's hold counted: the end retries
// (the affected set changed) or releases ask 2's unspent hold. The explicit
// stale askId the commands send is still refused with nothing moved. A top-up
// with no askId in the same gap rolls back too, so the run never holds twice.

import { expect, it as vitestIt } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import {
  AffectedSetChanged,
  endAtBudgetStop,
  topUpAtBudgetStop,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork, pickup, racer, type Work } from '../runtime/schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { as, moneyOf, one, people, setThreshold, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

/** Exactly the replay operation's priced maximum: one call fits, and none after it. */
const ONE_CALL = 500;

useBrokerWorld('endlatesthold');
usePeople();

const asks = async (runId: string) =>
  await s.db.admin.execute<{ id: string }>(
    `select id from public.budget_asks where run_id = $1 order by ask_number`,
    [runId],
  );

/** A run stopped once, at ask 1, with one call spent. */
async function stoppedOnce(title: string): Promise<{ work: Work; runId: string; askOne: string }> {
  await setThreshold(500);
  const work = await liveWork(s, title, ONE_CALL);
  world.provider.mode('answer');
  expect((await call(work)).ok).toBe(true);
  expect((await call(work)).ok).toBe(false);
  const { run_id: runId } = await one<{ run_id: string }>(
    `select run_id from public.leases where id = $1`,
    [work.picked['leaseId']],
  );
  const [askOne] = await asks(runId);
  return { work, runId, askOne: String(askOne?.id) };
}

/** On the world's own backend: ask 1 topped up, the replacement picked up, the run stopped at ask 2. */
async function stopAgain(work: Work, runId: string): Promise<void> {
  const topped = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...as(people.approver, runId),
        amountMinor: 300,
        currency: 'AUD',
      }),
  );
  expect(topped).toMatchObject({ ok: true, value: { state: 'applied' } });
  const again: Work = { ...work, picked: await pickup(s, work.decision['reservationId']) };
  for (let n = 0; n < 10; n += 1) {
    // Sequential: each call spends what the next one reads.
    // eslint-disable-next-line no-await-in-loop
    if ((await asks(runId)).length >= 2) break;
    // eslint-disable-next-line no-await-in-loop
    await call(again);
  }
  expect(await asks(runId), 'setup: the run stops a second time').toHaveLength(2);
}

/** An answer on a backend of its own, paused after its discovery until `meanwhile` has run. */
async function pausedAcross(
  answer: (tx: TenantQuery) => Promise<unknown>,
  meanwhile: () => Promise<void>,
): Promise<unknown> {
  const own = racer(s);
  let reach!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let paused = false;
  const pending = own
    .withBusiness(s.business, async (tx) => {
      const held: TenantQuery = {
        ...tx,
        query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
          const found = await tx.query<Row>(sql, parameters);
          const discovery =
            sql.includes('from public.planned_runs run') && sql.includes('k.reservation_id');
          if (!paused && discovery) {
            paused = true;
            reach();
            await gate;
          }
          return found;
        },
      };
      return await answer(held);
    })
    .then(
      (answered) => answered,
      (cause: unknown) => cause,
    );
  try {
    await reached;
    await meanwhile();
  } finally {
    resume();
  }
  const outcome = await pending;
  await own.close();
  return outcome;
}

it('an end with no askId, paused while the run stops again, never cancels it with the new hold kept', async () => {
  const { work, runId } = await stoppedOnce('end without an ask, run stops again');
  let atAskTwo: Awaited<ReturnType<typeof moneyOf>> | undefined;
  const end = as(people.second, runId);
  const outcome = await pausedAcross(
    async (tx) => await endAtBudgetStop(tx, end),
    async () => {
      await stopAgain(work, runId);
      atAskTwo = await moneyOf(runId);
    },
  );
  expect(atAskTwo).toMatchObject({ run: 'waiting_budget', reservation: 'held', asks: 2 });
  const after = await moneyOf(runId);
  expect(
    { run: after.run, reservation: after.reservation },
    "the run is not cancelled while ask 2's hold stays held",
  ).not.toEqual({ run: 'cancelled', reservation: 'held' });

  if (outcome instanceof AffectedSetChanged) {
    // Rolled back whole; the entry's retry discovers ask 2 and releases its hold.
    expect(after).toEqual(atAskTwo);
    const retried = await s.db.app.withBusiness(
      s.business,
      async (tx) => await endAtBudgetStop(tx, as(people.second, runId)),
    );
    expect(retried).toMatchObject({ ok: true });
  } else {
    expect(outcome).toMatchObject({ ok: true });
  }
  const ended = await moneyOf(runId);
  expect(ended).toMatchObject({ run: 'cancelled', reservation: 'abandoned', answers: 2 });
  expect(Number(ended.envelope_held), "ask 2's hold leaves the envelope").toBe(
    Number(atAskTwo?.envelope_held) - Number(atAskTwo?.held),
  );
});

it('an end naming ask 1, paused while the run stops at ask 2, is refused with nothing moved', async () => {
  const { work, runId, askOne } = await stoppedOnce('end naming a stale ask');
  let atAskTwo: Awaited<ReturnType<typeof moneyOf>> | undefined;
  const stale = { ...as(people.second, runId), askId: askOne };
  const outcome = await pausedAcross(
    async (tx) => await endAtBudgetStop(tx, stale),
    async () => {
      await stopAgain(work, runId);
      atAskTwo = await moneyOf(runId);
    },
  );
  expect(outcome).toMatchObject({ ok: false, refusal: { code: 'TRANSITION_NOT_PERMITTED' } });
  expect(await moneyOf(runId)).toEqual(atAskTwo);
});

const reservationsOf = async (runId: string) =>
  await s.db.admin.execute<{ id: string; state: string }>(
    `select id, state from public.reservations
      where business_id = $1 and run_id = $2 order by created_at, id`,
    [s.business, runId],
  );

it('a top-up with no askId, paused while the run stops again, rolls back and never holds twice', async () => {
  const { work, runId } = await stoppedOnce('top-up without an ask, run stops again');
  const topUp = { ...as(people.approver, runId), amountMinor: 300, currency: 'AUD' };
  let atAskTwo: Awaited<ReturnType<typeof moneyOf>> | undefined;
  let holdsAtAskTwo: Awaited<ReturnType<typeof reservationsOf>> = [];
  const outcome = await pausedAcross(
    async (tx) => await topUpAtBudgetStop(tx, topUp),
    async () => {
      await stopAgain(work, runId);
      atAskTwo = await moneyOf(runId);
      holdsAtAskTwo = await reservationsOf(runId);
    },
  );
  expect(atAskTwo).toMatchObject({ run: 'waiting_budget', reservation: 'held', asks: 2 });
  expect(outcome, 'the top-up found ask 1 and rolls back').toBeInstanceOf(AffectedSetChanged);
  expect(await moneyOf(runId), 'no new hold, the envelope maximum unchanged').toEqual(atAskTwo);
  expect(await reservationsOf(runId)).toEqual(holdsAtAskTwo);

  const retried = await s.db.app.withBusiness(
    s.business,
    async (tx) => await topUpAtBudgetStop(tx, topUp),
  );
  expect(retried).toMatchObject({ ok: true, value: { state: 'applied' } });
  const [, askTwo] = await asks(runId);
  const answered = await s.db.admin.execute<{ kind: string }>(
    `select kind from public.budget_answers where business_id = $1 and ask_id = $2`,
    [s.business, askTwo?.id],
  );
  expect(answered, 'the retry answers ask 2').toEqual([{ kind: 'top_up' }]);
  const after = await moneyOf(runId);
  expect(Number(after.maximum), 'the envelope is raised once').toBe(
    Number(atAskTwo?.maximum) + 300,
  );
  const held = (await reservationsOf(runId)).filter((row) => row.state === 'held');
  expect(held, 'the run holds once, against ask 2').toHaveLength(1);
});
