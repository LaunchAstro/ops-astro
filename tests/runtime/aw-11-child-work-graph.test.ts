// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 and the execution graph: a helper's hand-over and handback are events
// on the parent's run, and they never stand in for the run's own last move.

import { expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import type { Work } from './schedules-harness.ts';
import { noDatabase, useChildWorld, w } from './aw-11-child-world.ts';
import { codeOf, delegated, handBack } from './aw-11-child-work-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11g');

/** The parent run's observed layer on the task's execution graph. */
async function observedOf(work: Work): Promise<Record<string, unknown> | undefined> {
  const read = await executeRead(w.s.db.app, w.s.business, w.s.decider.presented, {
    read: 'task.execution',
    recordId: work.taskId,
  } as never);
  const graph = (
    read as {
      execution?: {
        graph?: { nodes: readonly { nodeId: string; observed: Record<string, unknown> }[] };
      };
    }
  ).execution?.graph;
  return graph?.nodes.find((node) => node.nodeId === work.picked['runId'])?.observed;
}

it('AW-11 a helper’s handback leaves the parent’s own drop fault on its graph node', async () => {
  const { work, credential } = await delegated(w.s, w.helper);
  // The parent's run ends on a drop with its fault, as recovery writes one.
  await w.s.db.admin.execute(
    `insert into public.run_events
       (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
     select business_id, gen_random_uuid(), run_id, task_id, position + 1, 'dropped', lease_id,
            attempt_id, actor_id, '{"fault": "ours"}'::jsonb
       from public.run_events where business_id = $1 and task_id = $2
      order by position desc limit 1`,
    [w.s.business, work.taskId],
  );
  expect(await observedOf(work)).toMatchObject({ fault: 'ours' });
  expect(
    codeOf(
      await handBack(w.s, w.helper, credential, { outcome: 'partial', refusal: 'LEASE_EXPIRED' }),
    ),
  ).toBe('ok');
  expect(await observedOf(work)).toMatchObject({ fault: 'ours' });
});
