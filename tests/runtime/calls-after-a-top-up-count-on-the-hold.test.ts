// SPDX-License-Identifier: AGPL-3.0-only
//
// SEC1 M2: a budget-stop top-up moves the spend to date, the calls that existed
// at its answer, to the envelope's actual (AW-05, `budget-answer.ts`). Calls
// made after it must count as on any hold (RUNTIME.md, "The model call's
// ledger"): observation adds a settled one to the cost and keeps the hold whole
// while one is open, and when that call settles it gives back nothing, since
// nothing counted it at its maximum. A call the top-up moved still counts once.
//
// The run's pickup after the top-up fences the stopped lease and replaces the
// topped-up hold with a fresh one, holding what it had left (`claimHold`,
// `pickup.ts`), so every later call lands on a hold no top-up answered. These
// pin that path: the replacement, and the three counts on it.

import { expect, it as vitestIt } from 'vitest';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  pickup,
  proposeBody,
  revisionOf,
  rows,
} from './schedules-harness.ts';
import { PRICED, t2dHarness, type Work } from './t2d-harness.ts';
import { seedLaunch } from './launch-seed.ts';
import { call, gated, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';
import { as, people, UNDER_ONE_CALL, usePeople } from '../broker/budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('topupcalls');
usePeople();

const { applied, observeOf } = t2dHarness(() => s);

/** What the synthetic comment is priced at (`PRICED`, the price book). */
const COMMENT_COST = 1_800;
/** Room for the comment and a call after it, under the four-eyes band. */
const TOP_UP = 3_000;
/** The replay operation's priced maximum: one call fits, and the next stops. */
const ONE_CALL = 500;

/** Synthetic work on a hold of `maximumMinor`, picked up and launched. */
async function workOn(maximumMinor: number): Promise<Work> {
  const taskId = await createTask(s, `topup calls ${freshPurpose()}`);
  const body = {
    ...proposeBody(taskId, await revisionOf(s, taskId), { purpose: freshPurpose(), maximumMinor }),
    step: { kind: 'synthetic_comment', payload: {} },
  };
  const proposal = appliedDetail(await asPerson(s, body), 'task.propose');
  const decision = await approve(s, proposal);
  const picked = await pickup(s, decision['reservationId']);
  await seedLaunch(s, picked);
  const [credential, attemptId] = [String(picked['credential']), String(picked['attemptId'])];
  return { taskId, proposal, decision, picked, credential, attemptId };
}

/** The next call stops at the ceiling, a person tops up, and the run is picked up again on a fresh hold. */
async function stopAndTopUp(w: Work): Promise<Work> {
  world.provider.mode('answer');
  expect(await call(w)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  const [lease] = await rows<{ run_id: string }>(
    s,
    'select run_id from public.leases where business_id = $1 and id = $2',
    [s.business, w.picked['leaseId']],
  );
  const request = { ...as(people.approver, String(lease?.run_id)), amountMinor: TOP_UP };
  const answered = await s.db.app.withBusiness(
    s.business,
    async (tx) => await topUpAtBudgetStop(tx, { ...request, currency: 'AUD' }),
  );
  expect(answered).toMatchObject({ ok: true, value: { state: 'applied' } });
  // The same version, so its launch mark (`seedLaunch`) still stands.
  const picked = await pickup(s, w.decision['reservationId']);
  const [fresh] = await rows<{ reservation_id: string }>(
    s,
    'select reservation_id from public.leases where business_id = $1 and id = $2',
    [s.business, picked['leaseId']],
  );
  expect(fresh?.reservation_id).not.toBe(w.decision['reservationId']);
  const [credential, attemptId] = [String(picked['credential']), String(picked['attemptId'])];
  return { ...w, picked, credential, attemptId };
}

/** The hold, its attempt and its envelope, as observation and settlement leave them. */
const moneyOf = async (w: Work) => {
  const [row] = await rows<Record<string, string | null>>(
    s,
    `select res.state, res.actual_minor::text as actual, att.state as attempt_state,
            env.actual_minor::text as envelope_actual
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
      where att.business_id = $1 and att.id = $2`,
    [s.business, w.attemptId],
  );
  if (row === undefined) throw new Error('no attempt to read');
  return row;
};

/** The settled spend of the calls on the lease's hold, and each call's state, oldest first. */
const callsOn = async (w: Work): Promise<{ settled: number; states: string[] }> => {
  const found = await rows<{ state: string; actual: string | null }>(
    s,
    `select state, actual_minor::text as actual from public.model_calls
      where business_id = $1 and state <> 'refused'
        and reservation_id = (select reservation_id from public.leases
                               where business_id = $1 and id = $2)
      order by accepted_at, id`,
    [s.business, w.picked['leaseId']],
  );
  return {
    settled: found.reduce((sum, one) => sum + Number(one.actual ?? 0), 0),
    states: found.map((one) => one.state),
  };
};

/** Poll `ready` every 25 ms, at most 400 times. */
const until = async (ready: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    if (await ready()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
};

it('a call settled after a budget top-up counts at observation, with the cost', async () => {
  const w = await stopAndTopUp(await workOn(UNDER_ONE_CALL));
  expect((await call(w)).ok).toBe(true);
  const calls = await callsOn(w);
  expect(calls.states).toStrictEqual(['settled']);
  expect(calls.settled).toBeGreaterThan(0);
  await applied(w);
  const before = await moneyOf(w);

  const observed = appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');

  const spent = COMMENT_COST + calls.settled;
  expect(observed['settlement']).toMatchObject({ state: 'settled', spentMinor: spent });
  expect(await moneyOf(w)).toMatchObject({
    state: 'actual',
    actual: String(spent),
    envelope_actual: String(Number(before['envelope_actual']) + spent),
  });
});

it('a call still open after a budget top-up keeps the hold whole, and its settle gives nothing back', async () => {
  const w = await stopAndTopUp(await workOn(UNDER_ONE_CALL));
  const custody = gated();
  const inFlight = call(w, {}, custody.broker);
  let held: Record<string, string | null> = {};
  try {
    await until(async () => (await callsOn(w)).states.join() === 'dispatched');
    expect((await callsOn(w)).states).toStrictEqual(['dispatched']);
    await applied(w);
    const before = await moneyOf(w);

    const observed = await observeOf(w, { usage: PRICED });

    // The cause is the open call (`call_open`), in the refusal's words.
    expect(codeOf(observed)).toBe('BUDGET_UNAVAILABLE');
    expect(JSON.stringify(observed)).toContain('sent and never settled');
    expect(await moneyOf(w)).toMatchObject({
      state: 'held',
      actual: null,
      attempt_state: 'liability_unknown',
      envelope_actual: before['envelope_actual'],
    });
    held = await moneyOf(w);
  } finally {
    custody.open();
  }
  expect((await inFlight).ok).toBe(true);
  expect((await callsOn(w)).states).toStrictEqual(['settled']);
  // Nothing counted the call at its maximum, so its settle takes nothing off the envelope.
  expect(await moneyOf(w)).toMatchObject({
    state: 'held',
    envelope_actual: held['envelope_actual'],
  });
});

it('a call settled before a budget top-up is counted once, by the top-up, never at observation', async () => {
  const w = await workOn(ONE_CALL);
  world.provider.mode('answer');
  expect((await call(w)).ok).toBe(true);
  const moved = (await callsOn(w)).settled;
  expect(moved).toBeGreaterThan(0);
  const topped = await stopAndTopUp(w);
  await applied(topped);
  const before = await moneyOf(topped);

  const observed = appliedDetail(await observeOf(topped, { usage: PRICED }), 'task.observe');

  expect(observed['settlement']).toMatchObject({ state: 'settled', spentMinor: COMMENT_COST });
  expect(await moneyOf(topped)).toMatchObject({
    state: 'actual',
    actual: String(COMMENT_COST),
    envelope_actual: String(Number(before['envelope_actual']) + COMMENT_COST),
  });
});
