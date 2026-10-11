// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch from the task, separation: the delegation one Launch mints acts on
// its own task and nowhere else. Presented by its agent it comments on that
// task; on another task of the same business, on a client's task, by another
// agent, and in another business it is refused, and nothing is written. A
// person of another business cannot launch this business's task, and a
// stored canary (the task title) never reaches any answer, refusals included.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { configuredCredentialKeys } from '../../packages/core-records/src/index.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo, installSpine } from './fixture.ts';
import {
  CANARY,
  aiWorld,
  assign,
  created,
  directsEvery,
  onClient,
  ownedAgent,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

/** What `codeOf` answers for a command that applied. */
const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('task-launch-isolation: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) {
    w = await aiWorld('launchiso');
    await directsEvery(w, w.p);
  }
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** The credential the runner will be handed, derived as the API derives it, never read from an answer. */
async function credentialFor(taskId: string): Promise<string> {
  const rows = await w.world.db.admin.execute<{
    readonly id: string;
    readonly agent: string;
    readonly key: string;
  }>(
    `select d.id, d.agent_actor_id::text as agent, d.credential_key_id as key
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.task_id = $1 and l.state = 'waiting'`,
    [taskId],
  );
  const row = rows[0];
  const keys = configuredCredentialKeys();
  if (row === undefined || !keys.ok) throw new Error('fixture: no launch to derive from');
  const credential = keys.keys.derive(row.key, {
    businessId: w.world.business,
    agentActorId: row.agent,
    delegationId: row.id,
  });
  if (credential === undefined) throw new Error('fixture: the key is not held');
  return credential;
}

/** A task held by the world's signed-in agent and launched by p. */
async function launched(title: string): Promise<string> {
  const task = await created(w, w.p, title);
  expect(codeOf(await assign(w, w.p, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
  const answer = await w.world.asPerson(w.p, {
    command: 'task.launch',
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await revisionOf(w, task),
  });
  expect(codeOf(answer)).toBe(APPLIED);
  return task;
}

const comment = async (taskId: string, credential: string): Promise<CommandResult> =>
  await w.world.asAgent(
    {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
      body: 'Working on it',
      audience: 'internal',
    },
    credential,
  );

/** `task.comment` sent by the agent signed in as `subject`, in `business`, under `credential`. */
const commentAs = async (
  business: string,
  subject: string,
  taskId: string,
  credential: string,
): Promise<CommandResult> =>
  (await executeAgentCommand(
    w.world.db.app,
    business as never,
    { provider: 'supabase', subject },
    credential,
    {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: 1,
      body: 'Not mine to say',
      audience: 'internal',
    } as never,
  )) as CommandResult;

/** Another agent of the business, signed in as itself. */
async function strangerSubject(): Promise<string> {
  const subject = `stranger-${randomUUID()}`;
  const stranger = await ownedAgent(w, w.q);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [tx.businessId, randomUUID(), loginId, stranger, w.p.actorId],
    );
  });
  return subject;
}

const commentsOn = async (taskId: string): Promise<number> => await w.world.commentsOn(taskId);

describe.skipIf(serverUrl === undefined)(
  'Launch isolation: the run delegation stays on its task',
  () => {
    it('acts on its own task', async () => {
      const task = await launched(`Own ${CANARY}`);
      const credential = await credentialFor(task);
      expect(codeOf(await comment(task, credential))).toBe(APPLIED);
      expect(await commentsOn(task)).toBe(1);
    });

    it('cannot act on another task of the business', async () => {
      const task = await launched('Launched one');
      const other = await created(w, w.p, `Other ${CANARY}`);
      const answer = await comment(other, await credentialFor(task));
      expect(codeOf(answer)).not.toBe(APPLIED);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(await commentsOn(other)).toBe(0);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'Launch isolation: other clients, agents and businesses',
  () => {
    it("cannot act on a client's task", async () => {
      const task = await launched('Internal launched');
      const theirs = await created(w, w.p, `Client ${CANARY}`);
      await onClient(w, theirs, randomUUID());
      const answer = await comment(theirs, await credentialFor(task));
      expect(codeOf(answer)).not.toBe(APPLIED);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(await commentsOn(theirs)).toBe(0);
    });

    it('cannot be presented by another agent', async () => {
      const task = await launched('Mine alone');
      const answer = await commentAs(
        w.world.business,
        await strangerSubject(),
        task,
        await credentialFor(task),
      );
      expect(codeOf(answer)).not.toBe(APPLIED);
      expect(await commentsOn(task)).toBe(0);
    });
  },
);

describe.skipIf(serverUrl === undefined)('Launch isolation: business to business', () => {
  it('cannot act in another business, and a person there cannot launch here', async () => {
    const task = await launched(`Home ${CANARY}`);
    const credential = await credentialFor(task);
    const bravo = await insertBusiness(w.world.db.app, `launch-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'comment', 'assign'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- four grants
        await grantTo(tx, there, action);
      }
      await grantTo(tx, there, 'assign', undefined, false, 'agent');
    });
    const fromThere = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.launch',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(w, task),
    } as never);
    expect(codeOf(fromThere)).toBe('NOT_FOUND');
    expect(JSON.stringify(fromThere)).not.toContain(CANARY);
    const made = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'Bravo task' },
    } as never);
    const bravoTask = (made as { recordId?: string }).recordId ?? '';
    const crossed = await commentAs(bravo, w.world.agentSubject(), bravoTask, credential);
    expect(codeOf(crossed)).not.toBe(APPLIED);
    expect(JSON.stringify(crossed)).not.toContain(CANARY);
  });
});
