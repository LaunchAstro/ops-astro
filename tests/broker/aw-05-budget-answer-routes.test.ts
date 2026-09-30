// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers at parity: `run.top_up` and `run.end_at_budget_stop` through
// the real API boundary and the shipped command-line client, over a run the
// broker really stopped at its ceiling. A person answers on the person prefix,
// four eyes included; the agent prefix refuses both, with or without a
// delegation, a live one for other work included. A repeat of one operation
// id is replayed, never applied twice. The crossings are
// `aw-05-budget-answer-routes-isolation.test.ts`.

import { expect, it as vitestIt } from 'vitest';
import { createCli } from '../../apps/cli/client.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { tokenFor } from '../api/fixture.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
import {
  alphaKey,
  api,
  asPerson,
  endBody,
  post,
  revisionOf,
  topUpBody,
  useAnswerRoutes,
} from './budget-answer-routes-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05routes');
usePeople();
useAnswerRoutes('aw05routes');

it('AW-05 run.top_up through the person route', async () => {
  await setThreshold(null);
  const { work, runId } = await stopped('topped up over the route');
  const body = topUpBody(work.taskId, runId);
  const answer = await asPerson(people.approver, '/run/top_up', body);
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    command: 'run.top_up',
    detail: { runId, state: 'applied' },
  });
  const after = await moneyOf(runId);
  expect(after).toMatchObject({ run: 'planned', answers: 1 });
  // The same operation id again is the same answer, replayed, and applies nothing more.
  const again = await asPerson(people.approver, '/run/top_up', body);
  expect(again.status).toBe(200);
  expect(again.body['detail']).toStrictEqual(answer.body['detail']);
  expect(await moneyOf(runId)).toStrictEqual(after);
});

it('AW-05 run.end_at_budget_stop through the person route', async () => {
  const { work, runId } = await stopped('ended over the route');
  const revision = await revisionOf(work.taskId);
  const answer = await asPerson(
    people.approver,
    '/run/end_at_budget_stop',
    endBody(work.taskId, runId),
  );
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    command: 'run.end_at_budget_stop',
    detail: { runId, state: 'cancelled' },
  });
  expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', answers: 1 });
  // Parked for a person: the task record is not written.
  expect(await revisionOf(work.taskId)).toBe(revision);
});

it('AW-05 the command line answers a budget stop', async () => {
  await setThreshold(null);
  const credential = await tokenFor(people.approver.presented.subject);
  const cli = createCli({
    businessKey: alphaKey,
    credential,
    transport: async (path, body, bearer) =>
      await api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
          body,
        }),
      ),
  });
  const topped = await stopped('topped up from the command line');
  const up = await cli.run('run.top_up', topUpBody(topped.work.taskId, topped.runId));
  expect(up.status).toBe(200);
  expect(await moneyOf(topped.runId)).toMatchObject({ run: 'planned', answers: 1 });
  const ended = await stopped('ended from the command line');
  const end = await cli.run('run.end_at_budget_stop', endBody(ended.work.taskId, ended.runId));
  expect(end.status).toBe(200);
  expect(await moneyOf(ended.runId)).toMatchObject({ run: 'cancelled', answers: 1 });
});

it('AW-05 above the threshold the route records one approval and a second person completes it', async () => {
  // Five dollars: a ten-dollar top-up needs two people.
  await setThreshold(5);
  try {
    const { work, runId } = await stopped('four eyes over the route');
    const first = await asPerson(people.approver, '/run/top_up', topUpBody(work.taskId, runId));
    expect(first.status).toBe(200);
    expect(first.body['detail']).toMatchObject({
      runId,
      state: 'awaiting_second',
      thresholdMinor: 500,
    });
    expect(await moneyOf(runId)).toMatchObject({ run: 'waiting_budget', answers: 0, approvals: 1 });
    // The same person again, under a fresh operation id, is refused and names the threshold.
    const twice = await asPerson(people.approver, '/run/top_up', topUpBody(work.taskId, runId));
    expect(twice.body['code']).toBe('FOUR_EYES_REQUIRED');
    expect(JSON.stringify(twice.body)).toContain('5');
    const second = await asPerson(people.second, '/run/top_up', topUpBody(work.taskId, runId));
    expect(second.status).toBe(200);
    expect(second.body['detail']).toMatchObject({ runId, state: 'applied' });
    expect(await moneyOf(runId)).toMatchObject({ run: 'planned', answers: 1, approvals: 2 });
  } finally {
    await setThreshold(null);
  }
});

it('AW-05 the agent prefix refuses both answers, with or without a delegation, a live one included', async () => {
  const { work, runId } = await stopped('an agent tries to answer');
  const agentToken = await tokenFor(s.agent.subject);
  // The stopped run's delegation is retired at the stop; the agent's live one
  // is for other work, in the same business.
  const live = await liveWork(s, 'the agent works something else', 2_000);
  const before = await moneyOf(runId);
  for (const [path, body] of [
    ['/run/top_up', topUpBody(work.taskId, runId)],
    ['/run/end_at_budget_stop', endBody(work.taskId, runId)],
  ] as const) {
    for (const headers of [
      { authorization: `Bearer ${agentToken}` },
      {
        authorization: `Bearer ${agentToken}`,
        [DELEGATION_HEADER]: String(work.picked['credential']),
      },
      {
        authorization: `Bearer ${agentToken}`,
        [DELEGATION_HEADER]: String(live.picked['credential']),
      },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time reads as a list
      const answer = await post(`a/b/${alphaKey}`, path, body, headers);
      expect(answer.status, path).toBe(403);
      expect(answer.body['code'], path).toBe('DELEGATION_EXCLUDES_OPERATION');
    }
  }
  expect(await moneyOf(runId)).toStrictEqual(before);
});
