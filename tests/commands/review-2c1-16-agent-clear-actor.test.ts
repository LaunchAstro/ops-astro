// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-16, as the assignment now stands: a person's command that ends
// an agent's work (task.cancel, task.propose's supersession, grant.revoke and
// access.end on the person it drew on) and a revocation no person ran each end
// the agent's delegation, and none takes the task from the agent. The task
// names the agent itself, not a delegation, so nothing clears it and no
// `task.assign` is audited on the agent's behalf: it stays until a person
// changes it (Assign to AI).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { revokeDelegation } from '../../packages/core-records/src/index.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { grantTo, WHOLE_BUSINESS } from './fixture.ts';
import {
  aiWorld,
  assign,
  assignEvents,
  created,
  holder,
  minted,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('review-2c1-16: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('rb16');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** P's agent (or `by`'s) picks up a task of theirs, and they assign it that agent. */
const agentAtWork = async (
  title: string,
  by: Decider = w.p,
): Promise<{
  readonly taskId: string;
  readonly delegation: string;
  readonly lineageId: string;
}> => {
  await w.world.db.admin.execute(`update public.actors set owner_person_id = $2 where id = $1`, [
    w.world.agentActorId,
    by.personId,
  ]);
  const picked = await w.world.pickUp(by, title);
  const delegation = String(picked.detail['delegationId']);
  const agent = w.world.agentActorId;
  expect(codeOf(await assign(w, by, picked.taskId, { agent }))).toBe('not-a-refusal');
  expect((await holder(w, picked.taskId))?.agent).toBe(agent);
  const lineage = await w.world.db.admin.execute<{ readonly id: string }>(
    `select lineage_id::text as id from public.planned_runs where business_id = $1 and task_id = $2`,
    [w.world.business, picked.taskId],
  );
  return { taskId: picked.taskId, delegation, lineageId: lineage[0]?.id ?? '' };
};

/** The delegation ended, the agent still holds the task, and no assignment was audited. */
const keptAfter = async (taskId: string, delegation: string, before: number): Promise<void> => {
  const ended = await w.world.db.admin.execute<{ readonly ended: boolean }>(
    `select revoked_at is not null as ended from public.delegations where id = $1`,
    [delegation],
  );
  expect(ended[0]?.ended).toBe(true);
  expect(await holder(w, taskId)).toStrictEqual({ agent: w.world.agentActorId, person: null });
  expect(await assignEvents(w, taskId)).toBe(before);
};

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-16 the agent keeps its task', () => {
  it('a person’s task.cancel ends the agent’s run and leaves it the task', async () => {
    const { taskId, delegation, lineageId } = await agentAtWork('Cancelled under the agent');
    const before = await assignEvents(w, taskId);
    const cancelled = await w.world.asPerson(w.q, {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: taskId,
      lineageId,
      reason: 'no longer needed',
    });
    expect(codeOf(cancelled)).toBe('not-a-refusal');
    await keptAfter(taskId, delegation, before);
  });

  it('a manager’s grant.revoke on the delegating person ends the run and leaves the agent the task', async () => {
    const { taskId, delegation } = await agentAtWork('Authority lost under the agent');
    const before = await assignEvents(w, taskId);
    await w.world.revokeGrant(String(w.p.grants['write']));
    await keptAfter(taskId, delegation, before);
  });
});

describe.skipIf(serverUrl === undefined)(
  'REVIEW-2C1-16 the agent keeps its task, continued',
  () => {
    it('a manager’s access.end on the delegating person ends the run and leaves the agent the task', async () => {
      // P's write was revoked above, so R is the person whose access ends here.
      const r = await w.world.decider('r');
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await grantTo(tx, r, 'assign');
        await grantTo(tx, w.q, 'manage', WHOLE_BUSINESS, false, 'access');
      });
      const { taskId, delegation } = await agentAtWork('Access ended under the agent', r);
      const before = await assignEvents(w, taskId);
      const ended = await w.world.asPerson(w.q, {
        command: 'access.end',
        operationId: randomUUID(),
        holderId: r.personId,
      });
      expect(codeOf(ended)).toBe('not-a-refusal');
      await keptAfter(taskId, delegation, before);
    });

    it('a revocation no person ran leaves the agent the task', async () => {
      const taskId = await created(w, w.q, 'Retired by the system under the agent');
      await w.world.db.admin.execute(
        `update public.actors set owner_person_id = $2 where id = $1`,
        [w.world.agentActorId, w.q.personId],
      );
      const delegation = await minted(w, w.q, taskId);
      const agent = w.world.agentActorId;
      expect(codeOf(await assign(w, w.q, taskId, { agent }))).toBe('not-a-refusal');
      const before = await assignEvents(w, taskId);
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await revokeDelegation(tx, delegation, 'work_retired');
      });
      await keptAfter(taskId, delegation, before);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'REVIEW-2C1-16 the agent keeps its task, on supersession',
  () => {
    it('a person’s task.propose superseding the picked-up version ends the run and leaves the agent the task', async () => {
      // S's agent works S's task; Q, who also writes it, proposes over it.
      const s = await w.world.decider('s');
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await grantTo(tx, s, 'assign');
      });
      const { taskId, delegation, lineageId } = await agentAtWork('Superseded under the agent', s);
      const before = await assignEvents(w, taskId);
      const proposed = await w.world.asPerson(w.q, {
        command: 'task.propose',
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(w, taskId),
        lineageId,
        purpose: `redraft_${randomUUID().slice(0, 8)}`,
        maximumMinor: 3_000,
        currency: 'AUD',
        payload: { instruction: 'draft it again' },
        step: { kind: 'compose', payload: {} },
      });
      expect(codeOf(proposed)).toBe('not-a-refusal');
      await keptAfter(taskId, delegation, before);
    });
  },
);
