// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8a (#1717; closes #778 and #786): the worker's identity is stored
// before use, from the work, never per process. Two workers on one
// delegation proposing at once name one operation, so the register opens one
// lineage and one gate (#778). A worker restarted after a person accepted its
// plan finds its own approved proposal in the queue and proposes nothing more
// (#786). A worker that dies after its agent's correction request committed
// and before its hand-back leaves one correction and one lineage when a fresh
// worker on the same delegation takes over. Every call goes through the real
// HTTP agent door.

import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import type { StepRunner } from '../../apps/worker/step-runner.ts';
import { createWorker, type WorkerOptions } from '../../apps/worker/worker.ts';
import { approve, rows } from '../runtime/schedules-harness.ts';
import { unproposed } from './compute-seam-world.ts';
import { correctionsOn, OWN_PAGE, ownSiteOf, requestOf } from './agent-draft-world.ts';
import { s, useStopWorld } from './run-stop-world.ts';

useStopWorld('r8aidentity');

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await ownSiteOf(s, OWN_PAGE);
}, 180_000);

/** The lineages and gates opened on `taskId`. */
async function opened(taskId: string): Promise<{ lineages: number; gates: number }> {
  const [found] = await rows<{ lineages: number; gates: number }>(
    s,
    `select count(distinct l.id)::int as lineages, count(g.id)::int as gates
       from public.proposal_lineages l
       left join public.gates g on g.business_id = l.business_id and g.lineage_id = l.id
      where l.business_id = $1 and l.task_id = $2`,
    [s.business, taskId],
  );
  return { lineages: Number(found?.lineages), gates: Number(found?.gates) };
}

/** A first worker's proposal on `options`' task, accepted by the person. */
async function proposedAndAccepted(options: WorkerOptions) {
  const worker = createWorker(options);
  const first = await worker.proposeOnce();
  if (!('proposed' in first)) throw new Error(`setup: propose ${JSON.stringify(first)}`);
  const [gate] = await rows<{ version_id: string }>(
    s,
    'select version_id::text as version_id from public.gates where id = $1',
    [first.proposed.gateId],
  );
  await approve(s, { gateId: first.proposed.gateId, versionId: String(gate?.version_id) });
  return worker;
}

/** A runner whose agent asks its correction, and whose worker then dies before the hand-back. */
const dies: StepRunner = {
  compute: async (context) => {
    const asked = await context.call('live_correction.request', {
      operationId: `correction:${context.attemptId}:1`,
      ...requestOf(context.taskId),
    });
    if (!('body' in asked)) throw new Error(`setup: request ${JSON.stringify(asked)}`);
    throw new Error('the worker died before its hand-back');
  },
};

describe.skipIf(serverUrl === undefined)("the worker's identity across processes", () => {
  it('opens one lineage and one gate when two workers on one delegation propose at once', async () => {
    const { taskId, options } = await unproposed('two workers at once');
    const outcomes = await Promise.all([
      createWorker(options).proposeOnce(),
      createWorker(options).proposeOnce(),
    ]);
    for (const outcome of outcomes) {
      expect(outcome, JSON.stringify(outcome)).toHaveProperty('proposed');
    }

    expect(await opened(taskId)).toEqual({ lineages: 1, gates: 1 });
  }, 120_000);

  it('finds its approved proposal after a restart and opens no second gate', async () => {
    const { taskId, options } = await unproposed('restarted after approval');
    await proposedAndAccepted(options);

    expect(await createWorker(options).proposeOnce()).toEqual({ queued: { taskId } });
    expect(await opened(taskId)).toEqual({ lineages: 1, gates: 1 });
  }, 120_000);

  it('leaves one correction and one lineage when it dies after its request and before its hand-back', async () => {
    const { taskId, options } = await unproposed('dies mid-run', dies);
    const first = await proposedAndAccepted(options);
    await expect(first.applyOnce(taskId)).rejects.toThrow('died');

    const restarted = createWorker(options);
    const proposed = await restarted.proposeOnce();
    expect(proposed, JSON.stringify(proposed)).not.toHaveProperty('refused');
    await restarted.applyOnce(taskId);

    expect(await correctionsOn(taskId)).toHaveLength(1);
    expect((await opened(taskId)).lineages).toBe(1);
  }, 120_000);
});
