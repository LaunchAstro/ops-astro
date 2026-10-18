// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 TEST F5, option 1 as ruled (design R6, split plan PR A2): the owner's
// Launch decision D commits, the real API process is stopped and seen to exit,
// and while it is down nothing is claimed, applied or effected. A fresh API
// process starts on the same database and port, and a fresh worker with
// nothing kept claims, dispatches, applies and observes through the real agent
// route, once. The receipt cites D, the version D approved and the effect's
// identity derived from the attempt. A live-API twin, never stopped, gives a
// receipt of the same shape.
//
// It runs on the synthetic apply (`apps/worker/worker.ts`); the integrated
// stack reruns it. Work continuing while the whole API is down is out of
// scope: the worker is an API client and cannot reach the database.

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { EFFECT_BODY } from '../../apps/worker/worker.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import {
  answers,
  API_PORTS,
  asPerson,
  footprint,
  launchedAt,
  newAgent,
  noDatabase,
  receiptAt,
  startApi,
  useRestartWorld,
  w,
  workerAt,
  type Launch,
} from './api-restart-world.ts';

/** What a receipt says about where it came from, with each identity checked against its source. */
function shapeOf(
  receipt: Readonly<Record<string, unknown>>,
  cited: { readonly taskId: string; readonly attemptId: string; readonly commentId: string },
  launch: Launch,
) {
  const decision = receipt['decision'] as Record<string, unknown>;
  const version = receipt['version'] as Record<string, unknown>;
  const effect = receipt['effect'] as Record<string, unknown>;
  return {
    keys: Object.keys(receipt).toSorted(),
    task: receipt['taskId'] === cited.taskId,
    attempt: receipt['attemptId'] === cited.attemptId,
    decision: {
      citesTheLaunch: decision['id'] === launch.decisionId,
      onItsGate: decision['gateId'] === launch.gateId,
      byTheOwner: decision['decidedByPersonId'] === w.fixture.member.personId,
      at: typeof decision['decidedAt'],
    },
    version: { approvedByTheLaunch: version['id'] === launch.versionId, number: version['number'] },
    link: receipt['link'],
    effect: {
      kind: effect['kind'],
      underTheAttemptsIdentity: effect['operationId'] === effectOperationId(cited.attemptId),
      theComment: effect['commentId'] === cited.commentId,
      audience: effect['audience'],
    },
    settlement: receipt['settlement'],
  };
}

/** Every identity a receipt of D's apply must cite. */
const CITES = {
  task: true,
  attempt: true,
  decision: { citesTheLaunch: true, onItsGate: true, byTheOwner: true, at: 'string' },
  version: { approvedByTheLaunch: true },
  effect: { underTheAttemptsIdentity: true, theComment: true, audience: 'internal' },
} as const;

const effectComments = async (origin: string, taskId: string): Promise<number> => {
  const read = await asPerson(origin, 'task.read', { recordId: taskId });
  const task = read.body['task'] as { comments?: readonly Record<string, unknown>[] };
  return (task.comments ?? []).filter((comment) => comment['body'] === EFFECT_BODY).length;
};

// eslint-disable-next-line max-lines-per-function -- one world, the restart and its live twin
describe.skipIf(noDatabase)('a Launch decision across an API restart', () => {
  useRestartWorld('r2restart');
  let restarted: ReturnType<typeof shapeOf> | undefined;

  // eslint-disable-next-line max-lines-per-function -- the decision, the stop, the down window and the restart
  it('commits D, stops the API and applies nothing while it is down, then a fresh API and worker apply D once and the receipt cites it', async () => {
    const agent = await newAgent();
    const first = await startApi(API_PORTS.restarted);
    const { taskId, delegation, handed, launch } = await launchedAt(first.origin, agent);
    expect(launch.versionId, 'D approves the reviewed output').toBe(handed.versionId);
    expect(launch.gateId).toBe(handed.gateId);

    // The API process is stopped by its PID and seen to exit.
    const exit = await first.stop();
    expect(exit, 'the API exits on its own shutdown').toStrictEqual({ code: 0, signal: null });
    expect(() => process.kill(first.pid, 0), 'no process has its PID').toThrow();
    expect(await answers(first.origin), 'nothing answers on its port').toBe(false);

    // While it is down a worker can claim nothing, and nothing is written.
    const down = await footprint(taskId);
    const tried = await workerAt(first.origin, agent, delegation)
      .applyOnce(taskId)
      .catch((fault: unknown) => ({ unreachable: String(fault) }));
    expect(tried, 'no apply while the API is down').not.toHaveProperty('applied');
    await delay(1_000);
    expect(await footprint(taskId), 'no claim, apply or effect while down').toBe(down);

    // A fresh API on the same database and port, and a fresh worker with nothing kept.
    const second = await startApi(API_PORTS.restarted);
    expect(second.pid).not.toBe(first.pid);
    const fresh = workerAt(second.origin, agent, delegation);
    const applied = await fresh.applyOnce(taskId);
    if (!('applied' in applied)) throw new Error(`apply: ${JSON.stringify(applied)}`);
    expect(await fresh.applyOnce(taskId), 'a second pass finds nothing').toStrictEqual({
      idle: { taskId },
    });
    expect(
      await workerAt(second.origin, agent, delegation).applyOnce(taskId),
      'nor does another fresh worker',
    ).toStrictEqual({ idle: { taskId } });
    expect(await effectComments(second.origin, taskId), 'the effect applied once').toBe(1);
    const observed = await w.fixture.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.attempts a
         join public.leases l on l.business_id = a.business_id and l.id = a.lease_id
        where a.business_id = $1 and l.task_id = $2 and a.observed`,
      [w.fixture.business, taskId],
    );
    expect(Number(observed[0]?.n), 'one observed attempt').toBe(1);

    const receipt = await receiptAt(second.origin, applied.applied.attemptId);
    expect((receipt['decision'] as Record<string, unknown>)['id'], 'the receipt cites D').toBe(
      launch.decisionId,
    );
    expect((receipt['version'] as Record<string, unknown>)['id']).toBe(launch.versionId);
    expect((receipt['effect'] as Record<string, unknown>)['operationId']).toBe(
      effectOperationId(applied.applied.attemptId),
    );
    restarted = shapeOf(receipt, applied.applied, launch);
    expect(restarted).toMatchObject(CITES);
    expect(await second.stop()).toStrictEqual({ code: 0, signal: null });
  }, 240_000);

  it('control: with the API live throughout, the same flow gives a receipt of the same shape', async () => {
    const agent = await newAgent();
    const live = await startApi(API_PORTS.live);
    const { taskId, delegation, launch } = await launchedAt(live.origin, agent);
    const applied = await workerAt(live.origin, agent, delegation).applyOnce(taskId);
    if (!('applied' in applied)) throw new Error(`apply: ${JSON.stringify(applied)}`);
    expect(await effectComments(live.origin, taskId)).toBe(1);
    const receipt = await receiptAt(live.origin, applied.applied.attemptId);
    const shape = shapeOf(receipt, applied.applied, launch);
    expect(shape).toMatchObject(CITES);
    expect(restarted, 'the restart case ran first').toBeDefined();
    expect(shape, 'the same receipt as across the restart').toStrictEqual(restarted);
    expect(await live.stop()).toStrictEqual({ code: 0, signal: null });
  }, 240_000);
});
