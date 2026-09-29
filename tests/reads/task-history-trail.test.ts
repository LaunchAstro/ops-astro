// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-16 isolation: the history a task page draws is `task.read`'s, filtered
// by the task's own address, against a real database. Another task's changes,
// another client's task and another business's task never reach it, and the
// actor who changed only those tasks never appears in its trail.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { agentWorld, detailOf, type AgentWorld } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-history-trail: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

let world: AgentWorld;
let writer: Member;
let other: Member;
let viewer: Member;
let bravoTask = '';
const ids: Record<string, string> = {};

const recordOf = (answer: unknown): string =>
  isCommandRefusal(answer as never)
    ? ''
    : String((answer as { readonly recordId?: unknown }).recordId ?? '');

const revision = async (recordId: string): Promise<number> => {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return Number(rows[0]?.revision);
};

const as = async (member: Member, body: Body): Promise<string> => {
  const answer = await executeCommand(world.db.app, world.business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return recordOf(answer);
};

/** A task `by` creates under `client`, then `stager` sets its stage `times` times. */
const make = async (by: Member, stager: Member, client: string, times: number) => {
  const recordId = await as(by, { command: 'task.create', fields: { title: 'a task' } });
  await as(by, {
    command: 'task.set_party',
    recordId,
    expectedRevision: await revision(recordId),
    fields: { client },
  });
  for (let index = 0; index < times; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- each write moves the revision
    const expectedRevision = await revision(recordId);
    // eslint-disable-next-line no-await-in-loop -- each write moves the revision
    await as(stager, {
      command: 'task.set_stage',
      recordId,
      expectedRevision,
      fields: { stage: `stage ${String(index)}` },
    });
  }
  return recordId;
};

const historyOf = async (member: Member, recordId: string) =>
  await executeRead(world.db.app, world.business, member.presented, {
    read: 'task.read',
    recordId,
  });

async function seed(): Promise<void> {
  world = await agentWorld('tht', `history-${randomUUID().slice(0, 8)}`);
  writer = await enrol(world.db.app, world.business, 'writer');
  other = await enrol(world.db.app, world.business, 'other-writer');
  viewer = await enrol(world.db.app, world.business, 'client-a-viewer');
  await world.db.app.withBusiness(world.business, async (tx) => {
    for (const member of [writer, other]) {
      for (const action of ['read', 'write', 'share'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one statement at a time
        await grantTo(tx, member, action);
      }
    }
  });
  ids['clientA'] = await make(writer, writer, randomUUID(), 1);
  ids['clientB'] = await make(writer, other, randomUUID(), 2);
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, viewer, 'read', { kind: 'record', id: ids['clientA'] ?? '' });
  });
  const bravo = (await insertBusiness(
    world.db.app,
    `bravo-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  const bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoOwner, 'read');
    await grantTo(tx, bravoOwner, 'write');
  });
  bravoTask = recordOf(
    await executeCommand(world.db.app, bravo, bravoOwner.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'bravo task' },
    } as never),
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-16 isolation', () => {
  it('the trail is the task’s own changes, and nobody else’s', async () => {
    const answer = await historyOf(writer, ids['clientA'] ?? '');
    if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task A not answered');
    expect(answer.task.history.map((entry) => entry.operation)).toStrictEqual([
      'task.create',
      'task.set_party',
      'task.set_stage',
    ]);
    expect(JSON.stringify(answer)).not.toContain(other.actorId);
  });

  it('another business: its task is not found and its history never sent', async () => {
    expect(bravoTask).not.toBe('');
    const answer = await historyOf(writer, bravoTask);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain('history');
  });

  it('another client in the same business: refused, and its writer never appears', async () => {
    const own = await historyOf(viewer, ids['clientA'] ?? '');
    expect(isCommandRefusal(own) ? own.code : 'answered').toBe('answered');
    expect(JSON.stringify(own)).not.toContain(other.actorId);
    const across = await historyOf(viewer, ids['clientB'] ?? '');
    expect(isCommandRefusal(across) ? across.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(across)).not.toContain(other.actorId);
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-16 isolation: an agent under a live delegation',
  () => {
    it('reads nothing of another task’s history', async () => {
      const decider = await world.decider('decider');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      expect(Object.keys(detailOf(own))).toContain('task');
      expect(JSON.stringify(own)).not.toContain(other.actorId);
      const across = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: ids['clientB'] ?? '' },
        picked.credential,
      );
      expect(isCommandRefusal(across) ? across.code : 'answered').not.toBe('answered');
      expect(JSON.stringify(across)).not.toContain(other.actorId);
    });
  },
);
