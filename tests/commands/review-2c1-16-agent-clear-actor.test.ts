// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-16 red proof: when a person's command ends an agent's work, the
// audit row that clears the agent from its task names the agent as the actor.
// revokeDelegation (packages/core-records/src/authority/delegations.ts) falls
// back to `revoked.agent_actor_id` when no actor is passed, and the runtime
// paths a person's command reaches (retireWork in lease-retirement.ts on
// task.cancel and on task.propose's supersession, the authority-loss revoke on
// grant.revoke) pass none. Passes once those paths carry the person who ran the
// command into the clear.

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

/** The actor on the newest applied task.assign audit row on the task. */
const lastAssignActor = async (taskId: string): Promise<string | undefined> =>
  (
    await w.world.db.admin.execute<{ readonly actor: string }>(
      `select actor_id::text as actor from public.audit_events
        where subject_record_id = $1 and command = 'task.assign' and outcome = 'applied'
        order by seq desc limit 1`,
      [taskId],
    )
  )[0]?.actor;

/** The actor on the newest applied audit row for a command in the business. */
const lastActorOf = async (command: string): Promise<string | undefined> =>
  (
    await w.world.db.admin.execute<{ readonly actor: string }>(
      `select actor_id::text as actor from public.audit_events
        where business_id = $1 and command = $2 and outcome = 'applied'
        order by seq desc limit 1`,
      [w.world.business, command],
    )
  )[0]?.actor;

/** P's agent (or `by`'s) picks up a task of theirs, and they assign it that agent. */
const agentAtWork = async (
  title: string,
  by: Decider = w.p,
): Promise<{ readonly taskId: string; readonly agent: string; readonly lineageId: string }> => {
  const picked = await w.world.pickUp(by, title);
  const agent = String(picked.detail['delegationId']);
  expect(codeOf(await assign(w, by, picked.taskId, { agent }))).toBe('not-a-refusal');
  expect((await holder(w, picked.taskId))?.agent).toBe(agent);
  const lineage = await w.world.db.admin.execute<{ readonly id: string }>(
    `select lineage_id::text as id from public.planned_runs where business_id = $1 and task_id = $2`,
    [w.world.business, picked.taskId],
  );
  return { taskId: picked.taskId, agent, lineageId: lineage[0]?.id ?? '' };
};

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-16 who clears the agent', () => {
  it('REVIEW-2C1-16: a person’s task.cancel clears the agent, and the clear is audited as that person, not the agent', async () => {
    const { taskId, lineageId } = await agentAtWork('Cancelled under the agent');
    const before = await assignEvents(w, taskId);
    const cancelled = await w.world.asPerson(w.q, {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: taskId,
      lineageId,
      reason: 'no longer needed',
    });
    expect(codeOf(cancelled)).toBe('not-a-refusal');
    expect(await holder(w, taskId)).toStrictEqual({ agent: null, person: null });
    expect(await assignEvents(w, taskId)).toBe(before + 1);
    const actor = await lastAssignActor(taskId);
    expect(
      actor,
      'the agent was named as the actor of the task.assign clear that Q’s task.cancel caused',
    ).not.toBe(w.world.agentActorId);
    expect(actor).toBe(w.q.actorId);
  });

  it('REVIEW-2C1-16: a manager’s grant.revoke on the delegating person clears the agent, audited as the manager, not the agent', async () => {
    const { taskId } = await agentAtWork('Authority lost under the agent');
    const before = await assignEvents(w, taskId);
    await w.world.revokeGrant(String(w.p.grants['write']));
    const manager = await lastActorOf('grant.revoke');
    expect(manager).toBeDefined();
    expect(await holder(w, taskId)).toStrictEqual({ agent: null, person: null });
    expect(await assignEvents(w, taskId)).toBe(before + 1);
    const actor = await lastAssignActor(taskId);
    expect(
      actor,
      'the agent was named as the actor of the task.assign clear that the manager’s grant.revoke caused',
    ).not.toBe(w.world.agentActorId);
    expect(actor).toBe(manager);
  });
});

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-16 who clears the agent, continued', () => {
  it('REVIEW-2C1-16: a manager’s access.end on the delegating person clears the agent, audited as that manager, not the agent', async () => {
    // P's write was revoked above, so R is the person whose access ends here.
    const r = await w.world.decider('r');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, r, 'assign');
      await grantTo(tx, w.q, 'manage', WHOLE_BUSINESS, false, 'access');
    });
    const { taskId } = await agentAtWork('Access ended under the agent', r);
    const before = await assignEvents(w, taskId);
    const ended = await w.world.asPerson(w.q, {
      command: 'access.end',
      operationId: randomUUID(),
      holderId: r.personId,
    });
    expect(codeOf(ended)).toBe('not-a-refusal');
    expect(await holder(w, taskId)).toStrictEqual({ agent: null, person: null });
    expect(await assignEvents(w, taskId)).toBe(before + 1);
    const actor = await lastAssignActor(taskId);
    expect(
      actor,
      'the agent was named as the actor of the task.assign clear that Q’s access.end caused',
    ).not.toBe(w.world.agentActorId);
    expect(actor).toBe(w.q.actorId);
  });

  it('REVIEW-2C1-16: a revocation no person ran (a system path naming no actor) still audits the clear as the agent', async () => {
    const taskId = await created(w, w.q, 'Retired by the system under the agent');
    const agent = await minted(w, w.q, taskId);
    expect(codeOf(await assign(w, w.q, taskId, { agent }))).toBe('not-a-refusal');
    const before = await assignEvents(w, taskId);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await revokeDelegation(tx, agent, 'work_retired');
    });
    expect((await holder(w, taskId))?.agent).toBeNull();
    expect(await assignEvents(w, taskId)).toBe(before + 1);
    expect(await lastAssignActor(taskId)).toBe(w.world.agentActorId);
  });
});

describe.skipIf(serverUrl === undefined)(
  'REVIEW-2C1-16 who clears the agent, on supersession',
  () => {
    it('REVIEW-2C1-16: a person’s task.propose superseding the picked-up version clears the agent, audited as the proposer, not the agent', async () => {
      // S's agent works S's task; Q, who also writes it, proposes over it.
      const s = await w.world.decider('s');
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await grantTo(tx, s, 'assign');
      });
      const { taskId, lineageId } = await agentAtWork('Superseded under the agent', s);
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
      expect(await holder(w, taskId)).toStrictEqual({ agent: null, person: null });
      expect(await assignEvents(w, taskId)).toBe(before + 1);
      const actor = await lastAssignActor(taskId);
      expect(
        actor,
        'the agent was named as the actor of the task.assign clear that Q’s task.propose caused',
      ).not.toBe(w.world.agentActorId);
      expect(actor).toBe(w.q.actorId);
    });
  },
);
