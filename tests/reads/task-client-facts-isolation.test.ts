// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8, CS-4.12: `task.read`'s `client` follows `client.list`'s rule. A
// reader is sent the task's client id only when their grants reach that
// client (a grant across the business, or one on the client); anyone else
// reads `client: null` beside `clientSet: true`, which the Client field draws
// "A client you cannot see". Three crossings, each with its own side served:
// another business, another client in the same business, a live delegation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  agentWorld,
  codeOf,
  detailOf,
  type AgentWorld,
  type Decider,
} from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-client-facts-isolation: DATABASE_URL is unset, so nothing below ran.');
}

let world: AgentWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) {
    world = await agentWorld('tcfi', `client-facts-${randomUUID().slice(0, 8)}`);
  }
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

type Body = Readonly<Record<string, unknown>>;

const revision = async (taskId: string): Promise<number> => {
  const [row] = await world.db.admin.execute<{ readonly revision: number }>(
    'select revision from public.records where id = $1',
    [taskId],
  );
  return Number(row?.revision);
};

/** A real client (C32), made by `by` given `record:write` across the business. */
async function clientBy(by: Member): Promise<string> {
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, by, 'write', WHOLE_BUSINESS, false, 'record');
  });
  const made = await world.asPerson(by, {
    command: 'client.create',
    operationId: randomUUID(),
    name: `A client ${randomUUID()}`,
  });
  if (isCommandRefusal(made)) throw new Error(`client.create refused ${made.code}`);
  return String(made.detail?.['clientId']);
}

/** A task put under `client` by `by`, who holds task:share. */
async function taskOf(by: Member, client: string): Promise<string> {
  const made = await world.asPerson(by, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'Under a client' },
  });
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  const taskId = String(made.recordId);
  const party = await world.asPerson(by, {
    command: 'task.set_party',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revision(taskId),
    fields: { client },
  });
  expect(codeOf(party)).toBe('not-a-refusal');
  return taskId;
}

/** `task.read` on the person path, as `member` in `business`. */
async function readAs(
  business: BusinessId,
  member: Member,
  taskId: string,
): Promise<{ readonly code: string; readonly task: Body | null; readonly body: string }> {
  const answer = await executeRead(world.db.app, business, member.presented, {
    read: 'task.read',
    recordId: taskId,
  } as never);
  const body = JSON.stringify(answer);
  if (isCommandRefusal(answer)) return { code: answer.code, task: null, body };
  const task = 'task' in answer ? (answer.task as unknown as Body) : null;
  return { code: 'ok', task, body };
}

interface Scene {
  readonly decider: Decider;
  readonly clientA: string;
  readonly clientB: string;
  readonly taskA: string;
}

/** Another business: its member is refused the task, and A's id never shows. */
async function crossBusiness({ clientA, taskA }: Scene): Promise<void> {
  const bravo = (await insertBusiness(
    world.db.app,
    `tcfi-b-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  const bravoReader = await enrol(world.db.app, bravo, 'bravo-reader');
  await world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoReader, 'read');
  });
  const fromBravo = await readAs(bravo, bravoReader, taskA);
  expect(fromBravo.code).toBe('NOT_FOUND');
  expect(fromBravo.body).not.toContain(clientA);
}

/**
 * Another client: held to B and shared A's one task, the task reads and its
 * client does not. Its own side: the same shape held to A, and a business-wide
 * reader, each read A.
 */
async function crossClient({ decider, clientA, clientB, taskA }: Scene): Promise<void> {
  const heldToB = await enrol(world.db.app, world.business, 'held-to-b');
  const heldToA = await enrol(world.db.app, world.business, 'held-to-a');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, heldToB, 'read', { kind: 'party', id: clientB });
    await grantTo(tx, heldToB, 'read', { kind: 'record', id: taskA });
    await grantTo(tx, heldToA, 'read', { kind: 'party', id: clientA });
    await grantTo(tx, heldToA, 'read', { kind: 'record', id: taskA });
  });
  const fromB = await readAs(world.business, heldToB, taskA);
  expect(fromB.code).toBe('ok');
  expect(fromB.task?.['client']).toBeNull();
  expect(fromB.task?.['clientSet']).toBe(true);
  expect(fromB.body).not.toContain(clientA);
  const fromA = await readAs(world.business, heldToA, taskA);
  expect([fromA.code, fromA.task?.['client']]).toStrictEqual(['ok', clientA]);
  expect((await readAs(world.business, decider, taskA)).task?.['client']).toBe(clientA);
}

/** A live delegation: the agent reads its own task without client facts, and not A's task. */
async function crossDelegation({ decider, clientA, taskA }: Scene): Promise<void> {
  const picked = await world.pickUp(decider, 'delegated');
  const own = await world.asAgent(
    { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
    picked.credential,
  );
  expect(codeOf(own)).toBe('not-a-refusal');
  const ownTask = detailOf(own)['task'] as Body;
  expect('client' in ownTask).toBe(false);
  expect('hasContent' in ownTask).toBe(false);
  const other = await world.asAgent(
    { command: 'task.read', operationId: randomUUID(), recordId: taskA },
    picked.credential,
  );
  expect(codeOf(other)).not.toBe('not-a-refusal');
  expect(JSON.stringify(other)).not.toContain(clientA);
}

describe.skipIf(serverUrl === undefined)('MP-4-8 task.read client id isolation', () => {
  it('MP-4-8 task.read sends a client id only to a reader whose grants reach that client', async () => {
    const decider = await world.decider('tcfi-decider');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, decider, 'share');
    });
    const [clientA, clientB] = [await clientBy(decider), await clientBy(decider)];
    const scene = { decider, clientA, clientB, taskA: await taskOf(decider, clientA) };
    await crossBusiness(scene);
    await crossClient(scene);
    await crossDelegation(scene);
  });
});
