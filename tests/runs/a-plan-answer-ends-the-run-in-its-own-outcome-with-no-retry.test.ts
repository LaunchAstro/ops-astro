// SPDX-License-Identifier: AGPL-3.0-only
//
// #1625 R9 (register 107): the owner's ChatGPT plan answering at its usage
// allowance ends the run `waiting_plan_allowance`, the plan unavailable (503)
// ends it `plan_unavailable`, and signing in again (401) ends it `cancelled`,
// each with its own code. Custody is asked once and never again: no retry, no
// saved pause, the old lease calls nothing more after a worker restart and
// the clock moving on. Only a person's `task.restart` starts a fresh attempt,
// and the stopped one keeps its row.
//
// The seam: no deployment registers the plan's task operation yet (#1971), so
// the replay operation is declared with the plan's own nothing-happened list
// and custody answers the plan's code as the plan route's custody does. The
// HTTP door, the broker, settlement and the database are the real ones.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { ModelBroker } from '../../packages/core-commands/src/commands/model-call.ts';
import {
  catalogue,
  CHATGPT_PLAN_NOTHING_HAPPENED,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import type { Custody } from '../../packages/core-custody/src/index.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  liveWork,
  pickup,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  authorityOf,
  brokerOver,
  callsOf,
  cancelTask,
  door,
  modelCall,
  modelCallBody,
  named,
  noDatabase,
  outcomesOf,
  restartAndAdvance,
  s,
  shapeOf,
  useStopWorld,
} from './run-stop-world.ts';
import { attemptOfLease, outcomesOfAttempt } from './run-outcomes-read.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('r9planend');

/** The replay operation declared as the plan's task operation will be: the plan's own list. */
const ON_PLAN: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.replay_on_plan',
  nothingHappened: CHATGPT_PLAN_NOTHING_HAPPENED,
};

/** Custody answering every send with the plan's `code`, nothing kept, counting each ask. */
function planAnswering(code: string): { readonly custody: Custody; readonly asked: () => number } {
  let asked = 0;
  const base = brokerOver().custody;
  return {
    custody: {
      ...base,
      dispatch: async () => {
        asked += 1;
        return await Promise.resolve({ kind: 'refused', started: false, code });
      },
    },
    asked: () => asked,
  };
}

const planBroker = (custody: Custody): ModelBroker => ({
  ...brokerOver(custody),
  operations: catalogue([REPLAY_COMPOSE, ON_PLAN]),
  providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
});

const fresh = async (what: string): Promise<Work> =>
  await liveWork(s, `r9 ${what} ${randomUUID()}`, 2_000);

/** The plan answers `code` once; the run ends in `expected`, and nothing is asked again. */
async function endsOnceWith(code: string, expected: ReturnType<typeof named>): Promise<Work> {
  const work = await fresh(code);
  const plan = planAnswering(code);
  const app = door(s.db.app, planBroker(plan.custody));
  const answer = await modelCall(work, app, modelCallBody(work, ON_PLAN.key));
  expect(answer.body['detail'], 'setup: the plan answered and the call is released').toMatchObject({
    state: 'released',
    outcome: 'CALL_RELEASED',
  });

  expect(shapeOf(await outcomesOf(work)), 'the stop records its one outcome').toEqual([expected]);
  expect(await authorityOf(work), 'the stop retires the work').toMatchObject({
    lease: 'released',
    cause: 'work_retired',
  });
  expect(await callsOf(work), 'the hold is released whole').toMatchObject([{ state: 'released' }]);
  const recorded = await outcomesOf(work);
  const calls = await callsOf(work);

  const again = await modelCall(work, app, modelCallBody(work, ON_PLAN.key));
  expect(again.status, 'the stopped lease calls nothing more').not.toBe(200);
  await restartAndAdvance(work);
  const later = await modelCall(work, app, modelCallBody(work, ON_PLAN.key));
  expect(later.status, 'nor after a worker restart and the clock moving on').not.toBe(200);

  expect(plan.asked(), 'the plan is asked once, never retried').toBe(1);
  expect(await outcomesOf(work), 'still one row, unchanged').toEqual(recorded);
  expect(await callsOf(work), 'the ledger is unchanged').toEqual(calls);
  return work;
}

it('the plan at its usage allowance ends the run waiting on plan allowance, asked once', async () => {
  await endsOnceWith(
    'SUBSCRIPTION_PLAN_ALLOWANCE',
    named('waiting_plan_allowance', 'SUBSCRIPTION_PLAN_ALLOWANCE'),
  );
});

it('the plan unavailable (503) ends the run plan_unavailable, asked once', async () => {
  await endsOnceWith(
    'SUBSCRIPTION_PLAN_UNAVAILABLE',
    named('plan_unavailable', 'SUBSCRIPTION_PLAN_UNAVAILABLE'),
  );
});

it('the plan needing its sign-in again (401) ends the run cancelled with its own code', async () => {
  await endsOnceWith(
    'SUBSCRIPTION_SIGN_IN_NEEDED',
    named('cancelled', 'SUBSCRIPTION_SIGN_IN_NEEDED'),
  );
});

it('the plan codes count only where the operation declares them: elsewhere held unknown', async () => {
  const work = await fresh('undeclared plan code');
  const plan = planAnswering('SUBSCRIPTION_PLAN_ALLOWANCE');
  await modelCall(work, door(s.db.app, planBroker(plan.custody)));

  expect(shapeOf(await outcomesOf(work))).toEqual([
    named('unknown_provider_outcome', 'LIABILITY_UNKNOWN'),
  ]);
  expect(await callsOf(work), 'the maximum stays held').toMatchObject([
    { state: 'liability_unknown' },
  ]);
});

it("a person's task.restart after the plan stop starts a fresh attempt; the stopped one keeps its row", async () => {
  const work = await endsOnceWith(
    'SUBSCRIPTION_PLAN_UNAVAILABLE',
    named('plan_unavailable', 'SUBSCRIPTION_PLAN_UNAVAILABLE'),
  );
  const stopped = await attemptOfLease(s.db.admin, s.business, String(work.picked['leaseId']));
  const kept = await outcomesOf(work);

  expect(await cancelTask(work), 'the person ends the stopped lineage').toBe('applied');
  const restarted = appliedDetail(
    await asPerson(s, {
      command: 'task.restart',
      operationId: randomUUID(),
      recordId: work.taskId,
      lineageId: work.proposal['lineageId'],
    }),
    'task.restart',
  );
  expect(restarted['restartsLineageId']).toBe(work.proposal['lineageId']);
  const picked = await pickup(s, (await approve(s, restarted))['reservationId']);
  const next = await attemptOfLease(s.db.admin, s.business, String(picked['leaseId']));

  expect(next.attemptId, 'a fresh attempt').not.toBe(stopped.attemptId);
  expect(await outcomesOfAttempt(s.db.admin, s.business, next.attemptId), 'it has no stop').toEqual(
    [],
  );
  expect(await outcomesOf(work), 'the stopped attempt keeps its row').toEqual(kept);
});

it('the table holds each plan code to its one outcome', async () => {
  const work = await endsOnceWith(
    'SUBSCRIPTION_PLAN_UNAVAILABLE',
    named('plan_unavailable', 'SUBSCRIPTION_PLAN_UNAVAILABLE'),
  );
  const { attemptId } = await attemptOfLease(
    s.db.admin,
    s.business,
    String(work.picked['leaseId']),
  );
  const moved = async (outcome: string, endCode: string): Promise<unknown> =>
    await s.db.admin
      .execute(
        `update public.run_outcomes set outcome = $3, end_code = $4
          where business_id = $1 and attempt_id = $2`,
        [s.business, attemptId, outcome, endCode],
      )
      .then(
        () => 'written',
        (error: unknown) =>
          (error as { constraint_name?: string }).constraint_name ?? String(error),
      );

  const foreign = [
    ['plan_unavailable', 'LOCAL_PLAN_LIMIT'],
    ['plan_unavailable', 'SUBSCRIPTION_PLAN_ALLOWANCE'],
    ['cancelled', 'SUBSCRIPTION_PLAN_UNAVAILABLE'],
    ['cancelled', 'SUBSCRIPTION_PLAN_ALLOWANCE'],
    ['waiting_plan_allowance', 'SUBSCRIPTION_SIGN_IN_NEEDED'],
  ] as const;
  const refusals = await Promise.all(
    foreign.map(async ([outcome, endCode]) => [outcome, endCode, await moved(outcome, endCode)]),
  );
  expect(refusals).toEqual(
    foreign.map(([outcome, endCode]) => [outcome, endCode, 'run_outcomes_end_code_of_outcome']),
  );
  expect(shapeOf(await outcomesOf(work))).toEqual([
    named('plan_unavailable', 'SUBSCRIPTION_PLAN_UNAVAILABLE'),
  ]);
});
