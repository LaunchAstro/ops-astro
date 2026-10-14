// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's stop and restore cases (agent-login-stop-restore.test.ts):
// an agent made through the tool, the agent door's answer to a bearer of a
// subject, and a live delegation as a pickup leaves one.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { executeAgentCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import {
  agentOf,
  makeArgs,
  mappingsOf,
  runAct,
  secret,
  type World,
} from './agent-login.fixture.ts';

/** A made agent: its id, the address its make was given, and its sign-in's subject. */
export async function made(
  world: World,
): Promise<{ agent: string; email: string; subject: string }> {
  const [agent, email] = [await agentOf(world), `h-${randomUUID().slice(0, 8)}@example.test`];
  expect((await runAct(world, { args: makeArgs(agent, email), password: secret() })).status).toBe(
    0,
  );
  const [mapping] = await mappingsOf(world, agent);
  return { agent, email, subject: mapping?.subject ?? '' };
}

/** The agent door's answer to a bearer of `subject` first signed in half a minute ago. */
export async function door(world: World, subject: string): Promise<string> {
  const signedInAt = Math.floor(Date.now() / 1000) - 30;
  const presented = {
    provider: 'supabase',
    subject,
    sessionId: randomUUID(),
    assurance: { level: 'aal1', signedInAt, factorAt: null } as const,
  };
  const request = { command: 'task.queue' as const, operationId: randomUUID() };
  const answer = await executeAgentCommand(
    world.db.app,
    world.alpha as BusinessId,
    presented,
    undefined,
    request,
  );
  return isCommandRefusal(answer) ? answer.code : 'answered';
}

/** A live delegation of `agent`'s, as a pickup leaves one. */
export async function delegate(world: World, agent: string): Promise<void> {
  await world.db.admin.transaction(async (execute) => {
    await execute('set local session_replication_role = replica');
    await execute(
      `insert into public.delegations (business_id, id, agent_actor_id, delegate_person_id,
         minted_by_actor_id, purpose, collections, actions, credential_hash, expires_at,
         purpose_scope_kind, purpose_scope_id)
       values ($1, gen_random_uuid(), $2, $3, $4, 'task_work', '{task}', '{read}',
         repeat('a', 64), now() + interval '1 hour', 'record', gen_random_uuid())`,
      [world.alpha, agent, world.ownerPerson, world.ownerActor],
    );
  });
}
