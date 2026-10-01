// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08's invariant, `the_second_accept_is_the_only_gate`, through the
// production command entry. Accepting the plan lets the agent work; it never
// releases an effect. The agent hands its output back for review, the effect
// its successor. Accepting that reviewed output is the launch: the one open
// decision, and the only thing that lets the effect be dispatched, once.
//
// Written before the code it covers. At this head the plan accept alone lets
// the effect be dispatched, so the first assertion is red for that reason.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Schedules,
} from './schedules-harness.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('aw08_second_accept', 1_000_000);
}, 180_000);

afterAll(async () => {
  if (noDatabase) return;
  await s.db.drop();
});

const EFFECT = { kind: 'synthetic_comment', payload: {} } as const;

/** Steps of the task's runs that a dispatch has marked. */
async function marked(taskId: string): Promise<number> {
  const found = await rows<{ n: string }>(
    s,
    `select count(*)::text as n
       from public.planned_steps st
       join public.gates g on g.business_id = st.business_id and g.run_id = st.run_id
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where l.business_id = $1 and l.task_id = $2 and st.dispatch_marked`,
    [s.business, taskId],
  );
  return Number(found[0]?.n);
}

/** The task's open decisions: each pending gate, with its version. */
async function openDecisions(
  taskId: string,
): Promise<readonly { gateId: string; versionId: string }[]> {
  return await rows<{ gateId: string; versionId: string }>(
    s,
    `select g.id as "gateId", g.version_id as "versionId"
       from public.gates g
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where l.business_id = $1 and l.task_id = $2 and g.state = 'pending'`,
    [s.business, taskId],
  );
}

const dispatchBody = (picked: Record<string, unknown>): Record<string, unknown> => ({
  command: 'task.dispatch',
  operationId: randomUUID(),
  leaseId: picked['leaseId'],
  fence: picked['fence'],
});

it('the_second_accept_is_the_only_gate: the plan accept never releases an effect; accepting the reviewed output does, once', async () => {
  const taskId = await createTask(s, `aw08-${randomUUID()}`);
  const plan = appliedDetail(
    await asPerson(s, {
      ...proposeBody(taskId, await revisionOf(s, taskId), { purpose: freshPurpose() }),
      step: EFFECT,
    }),
    'task.propose',
  );
  const working = await pickup(s, (await approve(s, plan))['reservationId']);
  const credential = String(working['credential']);

  const early = await asAgent(s, dispatchBody(working), credential);
  expect(codeOf(early), 'the plan accept alone released the effect').not.toBe('applied');
  expect(await marked(taskId)).toBe(0);

  const successor = {
    purpose: freshPurpose(),
    maximumMinor: 2_000,
    currency: 'AUD',
    payload: { change: 'the reviewed output' },
    step: EFFECT,
  };
  appliedDetail(await asAgent(s, handbackBody(working, successor), credential), 'task.handback');
  const open = await openDecisions(taskId);
  expect(open.length, 'exactly one accept is open: the reviewed output').toBe(1);
  expect(await marked(taskId)).toBe(0);

  const launched = await pickup(s, (await approve(s, open[0] ?? {}))['reservationId']);
  appliedDetail(
    await asAgent(s, dispatchBody(launched), String(launched['credential'])),
    'dispatch',
  );
  expect(await marked(taskId)).toBe(1);
  expect(await openDecisions(taskId)).toEqual([]);
});
