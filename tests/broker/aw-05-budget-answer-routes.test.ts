// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers at parity: `run.top_up` and `run.end_at_budget_stop` through
// the real API boundary and the shipped command-line client, over a run the
// broker really stopped at its ceiling. A person answers on the person prefix;
// the agent prefix refuses both, with or without the run's own delegation. A
// run on another task, another business's run and a fabricated one answer
// with the same bytes, and a person whose grants cover another task only is
// refused. Nothing moves on any refusal, and a repeat of one operation id is
// replayed, never applied twice.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { createCli } from '../../apps/cli/client.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
} from '../../packages/core-commands/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { ISSUER, SECRET, tokenFor } from '../api/fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { liveWork, seedSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, one, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05routes');
usePeople();

interface Answer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

let api: Hono;
let alphaKey: string;
let bravo: Schedules;
let bravoKey: string;
let narrow: Member;

const keyOf = async (business: string): Promise<string> =>
  (await one<{ key: string }>('select key from public.businesses where id = $1', [business])).key;

beforeAll(async () => {
  if (noDatabase) return;
  api = createApi({
    database: s.db.app,
    verify: createSupabaseVerifier({ secret: SECRET, issuer: ISSUER }),
    resolveBusiness: createBusinessResolver(s.db.admin),
    executeRead,
    executeCommand,
    executeAgentCommand,
  });
  alphaKey = await keyOf(s.business);
  // Another business on the same installation, whose decider holds both
  // answers' grants business-wide in their own business.
  bravo = await seedSchedules(s.db, 'aw05routesb', 1_000_000);
  bravoKey = await keyOf(bravo.business);
  await bravo.db.app.withBusiness(bravo.business, async (tx) => {
    await grantTo(tx, bravo.decider, 'decide', undefined, false, 'billing');
    await grantTo(tx, bravo.decider, 'decide', undefined, false, 'gate');
  });
}, 180_000);

const post = async (
  prefix: string,
  path: string,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>>,
): Promise<Answer> => {
  const response = await api.fetch(
    new Request(`http://api.test/api/${prefix}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Answer['body'] };
};

const asPerson = async (
  member: Member,
  path: string,
  body: Readonly<Record<string, unknown>>,
  key: string = alphaKey,
): Promise<Answer> =>
  await post(`b/${key}`, path, body, {
    authorization: `Bearer ${await tokenFor(member.presented.subject)}`,
  });

const topUpBody = (
  taskId: string,
  runId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  operationId: randomUUID(),
  recordId: taskId,
  runId,
  amountMinor: 1_000,
  currency: 'AUD',
  ...extra,
});

const endBody = (taskId: string, runId: string): Record<string, unknown> => ({
  operationId: randomUUID(),
  recordId: taskId,
  runId,
});

const revisionOf = async (taskId: string): Promise<string> =>
  (
    await one<{ revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    )
  ).revision;

/** A refusal's bytes, less the one field that is the caller's own. */
const bytesOf = (answer: Answer): string => {
  const { operationId: _own, ...rest } = answer.body;
  return JSON.stringify({ status: answer.status, ...rest });
};

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

it('AW-05 isolation: the answer routes', async () => {
  await setThreshold(null);
  const { work, runId } = await stopped('the run the crossings aim at');
  const other = await stopped('a run on another task in the same business');
  const before = await moneyOf(runId);
  const otherBefore = await moneyOf(other.runId);

  // Another business: bravo's decider, on bravo's own prefix, naming alpha's task and run.
  const foreign = await asPerson(
    bravo.decider,
    '/run/top_up',
    topUpBody(work.taskId, runId),
    bravoKey,
  );
  const foreignEnd = await asPerson(
    bravo.decider,
    '/run/end_at_budget_stop',
    endBody(work.taskId, runId),
    bravoKey,
  );
  expect(foreign.body['code']).toBe('NOT_FOUND');
  expect(foreignEnd.body['code']).toBe('NOT_FOUND');

  // The same business, another task's run under this task's name, and a
  // fabricated run: the same bytes, so the answer tells nothing about the other.
  const crossed = await asPerson(
    people.approver,
    '/run/top_up',
    topUpBody(work.taskId, other.runId),
  );
  const fabricated = await asPerson(
    people.approver,
    '/run/top_up',
    topUpBody(work.taskId, randomUUID()),
  );
  expect(crossed.body['code']).toBe('NOT_FOUND');
  expect(bytesOf(crossed)).toBe(bytesOf(fabricated));
  const crossedEnd = await asPerson(
    people.approver,
    '/run/end_at_budget_stop',
    endBody(work.taskId, other.runId),
  );
  const fabricatedEnd = await asPerson(
    people.approver,
    '/run/end_at_budget_stop',
    endBody(work.taskId, randomUUID()),
  );
  expect(bytesOf(crossedEnd)).toBe(bytesOf(fabricatedEnd));

  // A person whose grants cover another task only (the client stand-in until C32).
  narrow = await enrol(s.db.app, s.business, 'narrow');
  await s.db.app.withBusiness(s.business, async (tx) => {
    const scope = { kind: 'record', id: other.work.taskId } as const;
    await grantTo(tx, narrow, 'decide', scope, false, 'billing');
    await grantTo(tx, narrow, 'decide', scope, false, 'gate');
  });
  const outside = await asPerson(narrow, '/run/top_up', topUpBody(work.taskId, runId));
  const outsideEnd = await asPerson(narrow, '/run/end_at_budget_stop', endBody(work.taskId, runId));
  expect(outside.body['code']).toBe('SCOPE_NOT_GRANTED');
  expect(outsideEnd.body['code']).toBe('SCOPE_NOT_GRANTED');

  // No refusal carries the other run's id or either task's id, and nothing moved.
  for (const answer of [foreign, foreignEnd, crossed, crossedEnd, outside, outsideEnd]) {
    expect(JSON.stringify(answer.body)).not.toContain(other.runId);
    expect(JSON.stringify(answer.body)).not.toContain(other.work.taskId);
  }
  expect(JSON.stringify(foreign.body)).not.toContain(work.taskId);
  expect(await moneyOf(runId)).toStrictEqual(before);
  expect(await moneyOf(other.runId)).toStrictEqual(otherBefore);
});
