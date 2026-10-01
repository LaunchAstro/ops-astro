// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-16 red proof: when a person's command ends an agent's work, the
// audit row that clears the agent from its task names the agent as the actor.
// revokeDelegation (packages/core-records/src/authority/delegations.ts) falls
// back to `revoked.agent_actor_id` when no actor is passed, and the runtime
// paths a person's command reaches (retireWork in lease-retirement.ts on
// task.cancel, the authority-loss revoke on grant.revoke) pass none. Passes
// once those paths carry the person who ran the command into the clear.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from './agent-fixture.ts';
import { aiWorld, assign, assignEvents, holder, type AiWorld } from './ai-assign-world.ts';

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

/** P's agent picks up a task of P's, and P assigns it that agent. */
const agentAtWork = async (
  title: string,
): Promise<{ readonly taskId: string; readonly agent: string; readonly lineageId: string }> => {
  const picked = await w.world.pickUp(w.p, title);
  const agent = String(picked.detail['delegationId']);
  expect(codeOf(await assign(w, w.p, picked.taskId, { agent }))).toBe('not-a-refusal');
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
