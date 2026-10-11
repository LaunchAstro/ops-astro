// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the Assign to AI suites: the agent world with two people who may
// assign, their tasks, agents each of them owns, delegations minted for a
// run's authority, and the readers for what a task holds.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { configuredCredentialKeys, mintDelegation } from '../../packages/core-records/src/index.ts';
import { agentWorld, codeOf, type AgentWorld, type Decider } from './agent-fixture.ts';
import { agentOwnedBy, grantTo } from './fixture.ts';

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

/** A fresh agent of the world's business, owned by `by` and named. */
export const ownedAgent = async (
  w: AiWorld,
  by: { readonly personId: string },
  name?: string,
): Promise<string> => await agentOwnedBy(w.world.db.app, w.world.business, by.personId, name);

/** `agent:assign` over the whole business: `by` directs every agent, not only their own. */
export const directsEvery = async (w: AiWorld, by: Decider): Promise<string> =>
  await w.world.db.app.withBusiness(
    w.world.business,
    async (tx) => await grantTo(tx, by, 'assign', undefined, false, 'agent'),
  );

/** A live delegation of `by`'s own for an agent (the world's by default) on one task: a run's authority. */
export const minted = async (
  w: AiWorld,
  by: Decider,
  taskId: string,
  agentActorId: string = w.world.agentActorId,
): Promise<string> =>
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const made = await mintDelegation(tx, {
      agentActorId,
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

/** What the task holds: its agent (an agent actor) and its person assignee. */
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

/** The agents `task.read` offers this reader for the task. */
export const offered = async (w: AiWorld, by: Decider, taskId: string): Promise<unknown> => {
  const read = await executeRead(w.world.db.app, w.world.business, by.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  if (isCommandRefusal(read) || !('task' in read)) return read;
  return (read.task as unknown as { myAgents?: unknown }).myAgents;
};

/** The agent `task.read` says holds the task, as this reader is sent it. */
export const heldAs = async (w: AiWorld, by: Decider, taskId: string): Promise<unknown> => {
  const read = await executeRead(w.world.db.app, w.world.business, by.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  if (isCommandRefusal(read) || !('task' in read)) return read;
  return read.task.agent;
};

/** Set a task's client directly, as the data holds it: the crossing's setup, not a path under test. */
export const onClient = async (w: AiWorld, taskId: string, client: string): Promise<void> => {
  await w.world.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [taskId, client],
  );
};

/** `task.launch` by a person, at the task's current revision, as its answer's code. */
export const launch = async (w: AiWorld, by: Decider, taskId: string): Promise<string> =>
  codeOf(
    await w.world.asPerson(by, {
      command: 'task.launch',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
    }),
  );

/** The credential the runner is handed for the task's waiting launch, derived as the API derives it. */
export async function launchCredential(w: AiWorld, taskId: string): Promise<string> {
  const [row] = await w.world.db.admin.execute<{ readonly id: string; readonly key: string }>(
    `select d.id, d.credential_key_id as key
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.task_id = $1 and l.state = 'waiting'`,
    [taskId],
  );
  const keys = configuredCredentialKeys();
  if (row === undefined || !keys.ok) throw new Error('fixture: no launch to derive from');
  const credential = keys.keys.derive(row.key, {
    businessId: w.world.business,
    agentActorId: w.world.agentActorId,
    delegationId: row.id,
  });
  if (credential === undefined) throw new Error('fixture: the key is not held');
  return credential;
}

export type Gate = {
  readonly gateId: string;
  readonly versionId: string;
};

/** The world agent's proposal on the task, under the launch's delegation unless another credential is named. */
export async function agentProposes(
  w: AiWorld,
  taskId: string,
  credential?: string,
): Promise<Gate> {
  const answer = await w.world.asAgent(
    {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
      purpose: `gate_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    },
    credential ?? (await launchCredential(w, taskId)),
  );
  if (isCommandRefusal(answer)) throw new Error(`task.propose refused ${answer.code}`);
  return answer.detail as Gate;
}

/** `task.decide` approving the gate, as its answer's code. */
export const decide = async (w: AiWorld, by: Decider, gate: Gate): Promise<string> =>
  codeOf(
    await w.world.asPerson(by, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: gate.gateId,
      versionId: gate.versionId,
      decision: 'approve',
      note: 'a second person decides',
    }),
  );

/** Who holds an open decision item on the gate. */
export const offeredTo = async (w: AiWorld, gateId: string): Promise<readonly string[]> =>
  (
    await w.world.db.admin.execute<{ readonly person: string }>(
      `select recipient_person_id::text as person from public.inbox_items
        where reason = 'decision' and fact_kind = 'gate' and fact_id = $1 and work_state = 'open'`,
      [gateId],
    )
  ).map((row) => row.person);
