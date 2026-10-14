// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the take-a-launch suites: an internal task held by the world's
// signed-in agent and launched by P, the agent's `task.take_launch` and the
// launch and delegation rows as the database holds them.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { configuredCredentialKeys } from '../../packages/core-records/src/index.ts';
import { codeOf } from './agent-fixture.ts';
import { assign, created, launch, type AiWorld } from './ai-assign-world.ts';

/** What `codeOf` answers for a command that applied. */
export const APPLIED = 'not-a-refusal';

/** An internal task held by the world's agent, owned by P, and launched by P. */
export async function launchedTask(w: AiWorld, title: string): Promise<string> {
  const task = await created(w, w.p, title);
  await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
    w.p.personId,
    w.world.agentActorId,
  ]);
  expect(codeOf(await assign(w, w.p, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
  expect(await launch(w, w.p, task)).toBe(APPLIED);
  return task;
}

export interface LaunchRow {
  readonly id: string;
  readonly state: string;
  readonly takenFor: string | null;
  readonly takenAt: string | null;
  readonly delegationId: string;
  readonly settled: boolean;
}

/** The task's one launch, as the database holds it. */
export async function launchOf(w: AiWorld, taskId: string): Promise<LaunchRow> {
  const [row] = await w.world.db.admin.execute<LaunchRow>(
    `select l.id, l.state, to_jsonb(l) ->> 'taken_for' as "takenFor",
            to_jsonb(l) ->> 'taken_at' as "takenAt",
            l.delegation_id as "delegationId", d.settled_at is not null as settled
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.task_id = $1`,
    [taskId],
  );
  if (row === undefined) throw new Error('fixture: the task has no launch');
  return row;
}

/** The launch's credential, derived as the API derives it, whatever the launch's state. */
export async function derivedFor(w: AiWorld, launchId: string): Promise<string> {
  const [row] = await w.world.db.admin.execute<{ readonly id: string; readonly key: string }>(
    `select d.id, d.credential_key_id as key
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.id = $1`,
    [launchId],
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

/** `task.take_launch` by the world's agent login, naming the launch or none. */
export const take = async (
  w: AiWorld,
  launchId?: string,
  credential?: string,
): Promise<CommandResult> =>
  await w.world.asAgent(
    {
      command: 'task.take_launch',
      operationId: randomUUID(),
      ...(launchId === undefined ? {} : { launchId }),
    },
    credential,
  );

/** The answer's detail: what a take hands back. */
export const takenAs = (result: CommandResult): Readonly<Record<string, unknown>> =>
  'detail' in result && result.detail !== undefined && result.detail !== null
    ? (result.detail as Record<string, unknown>)
    : { refused: codeOf(result) };
