// SPDX-License-Identifier: AGPL-3.0-only
//
// U112 Core 04 6, against a real database: the commands the new-task draft
// sends at Create, in its order (client, project, stage, then the details),
// write every chosen field, and `task.read` reads each one back. The client
// goes first because any later write is content and locks it (S0-5).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { clientHere } from './client-rows.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('u112-draft-create-readback: DATABASE_URL is unset, so nothing below ran.');
}

type Body = Readonly<Record<string, unknown>>;

interface World {
  readonly db: FreshDatabase;
  readonly business: BusinessId;
  readonly owner: Member;
  readonly clientId: string;
  readonly projectId: string;
}

async function send(world: World, body: Body) {
  return await executeCommand(world.db.app, world.business, world.owner.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
}

async function applied(world: World, body: Body) {
  const answer = await send(world, body);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
}

async function seed(): Promise<World> {
  const db = await createFreshDatabase({ part: 'u112' });
  const business = (await insertBusiness(db.app, 'u112-alpha')) as BusinessId;
  await installSpine(db.app, business);
  const owner = await enrol(db.app, business, 'owner');
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write', 'share'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, action);
    }
  });
  const clientId = await clientHere(db.admin, business, randomUUID());
  const partial = { db, business, owner, clientId, projectId: '' };
  const project = await applied(partial, {
    command: 'task.create',
    fields: { title: 'Website rebuild' },
  });
  return { ...partial, projectId: project.recordId ?? '' };
}

/** Create a task the way the draft does, then read every chosen field back. */
async function createInDraftOrder(world: World): Promise<void> {
  const made = await applied(world, {
    command: 'task.create',
    fields: { title: 'Rebuild the booking page', estimated_minutes: 120 },
    board: null,
  });
  const recordId = made.recordId ?? '';
  let revision = made.revision ?? 0;
  for (const part of [
    { command: 'task.set_party', fields: { client: world.clientId } },
    { command: 'task.move', board: world.projectId },
    { command: 'task.set_stage', fields: { stage: 'enquiries' } },
    {
      command: 'task.update',
      fields: {
        description: 'Mobile users drop off.',
        agent_brief: 'Test on a phone.',
        priority: 2,
      },
    },
  ]) {
    // eslint-disable-next-line no-await-in-loop -- each part names the revision the last one wrote
    const answer = await applied(world, { ...part, recordId, expectedRevision: revision });
    revision = answer.revision ?? revision;
  }
  const read = await executeRead(world.db.app, world.business, world.owner.presented, {
    read: 'task.read',
    recordId,
  });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  expect(read.task).toMatchObject({
    title: 'Rebuild the booking page',
    client: world.clientId,
    board: { readable: true, id: world.projectId, title: 'Website rebuild' },
    stage: 'enquiries',
    priority: 2,
    description: 'Mobile users drop off.',
    agentBrief: 'Test on a phone.',
  });
}

describe.skipIf(serverUrl === undefined)('U112 Core 04 6: every draft field reads back', () => {
  let world: World;

  beforeAll(async () => {
    world = await seed();
  }, 180_000);

  afterAll(async () => {
    await world?.db.drop();
  });

  it('the draft’s commands in order write the client, project, stage, priority, description and brief', async () => {
    await createInDraftOrder(world);
  });

  it('a client sent after the project would be refused, which is why the draft sends it first', async () => {
    const made = await applied(world, {
      command: 'task.create',
      fields: { title: 'Out of order' },
    });
    const recordId = made.recordId ?? '';
    const moved = await applied(world, {
      command: 'task.move',
      recordId,
      board: world.projectId,
      expectedRevision: made.revision,
    });
    const late = await send(world, {
      command: 'task.set_party',
      recordId,
      expectedRevision: moved.revision,
      fields: { client: world.clientId },
    });
    expect(isCommandRefusal(late) ? late.code : 'applied').toBe('CLIENT_LOCKED');
  });
});
