// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the Assign to AI suites: the agent world with two people who may
// assign, their tasks, delegations minted on one task each, and the readers
// for what a task holds.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';
import { grantTo } from './fixture.ts';

export const CANARY: string = `canary-${randomUUID()}`;

export interface AiWorld {
  readonly world: AgentWorld;
  /** Holds read, write, decide, comment and assign on tasks. */
  readonly p: Decider;
  readonly q: Decider;
}

export async function aiWorld(part: string): Promise<AiWorld> {
  const world = await agentWorld(part, `ai-${randomUUID().slice(0, 8)}`);
  const p = await world.decider('p');
  const q = await world.decider('q');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, p, 'assign');
    await grantTo(tx, q, 'assign');
  });
  return { world, p, q };
}

export const revisionOf = async (w: AiWorld, recordId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision ?? '0',
  );

export const created = async (w: AiWorld, by: Decider, title: string): Promise<string> => {
  const answer = await w.world.asPerson(by, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  });
  if (isCommandRefusal(answer)) throw new Error(`task.create refused ${answer.code}`);
  return answer.recordId ?? '';
};

/** A live delegation of `by`'s own, for the world's agent, on one task. */
export const minted = async (w: AiWorld, by: Decider, taskId: string): Promise<string> =>
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const made = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: by.personId,
      mintedByActorId: by.actorId,
      purpose: `ai_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!made.ok) throw new Error(`fixture: the mint was refused ${made.refusal.code}`);
    return made.value.delegation.id;
  });

/** `task.assign` by a person, at the task's current revision. */
export const assign = async (
  w: AiWorld,
  by: Decider,
  taskId: string,
  fields: Readonly<Record<string, unknown>>,
  operationId: string = randomUUID(),
): Promise<CommandResult> =>
  await w.world.asPerson(by, {
    command: 'task.assign',
    operationId,
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
    fields,
  });

/** What the task holds: its agent (a delegation) and its person assignee. */
export const holder = async (
  w: AiWorld,
  taskId: string,
): Promise<{ readonly agent: string | null; readonly person: string | null } | undefined> =>
  (
    await w.world.db.admin.execute<{
      readonly agent: string | null;
      readonly person: string | null;
    }>(
      `select data ->> 'agent' as agent, uuid_2::text as person from public.records where id = $1`,
      [taskId],
    )
  )[0];

/** The task's audit events under `task.assign`, as the chain holds them. */
export const assignEvents = async (w: AiWorld, taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.audit_events
          where subject_record_id = $1 and command = 'task.assign' and outcome = 'applied'`,
        [taskId],
      )
    )[0]?.n ?? '0',
  );

/** The agents `task.read` offers this reader for the task: their own, reaching it. */
export const offered = async (w: AiWorld, by: Decider, taskId: string): Promise<unknown> => {
  const read = await executeRead(w.world.db.app, w.world.business, by.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  if (isCommandRefusal(read) || !('task' in read)) return read;
  return (read.task as unknown as { myAgents?: unknown }).myAgents;
};

/** Set a task's client directly, as the data holds it: the crossing's setup, not a path under test. */
export const onClient = async (w: AiWorld, taskId: string, client: string): Promise<void> => {
  await w.world.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [taskId, client],
  );
};
