// SPDX-License-Identifier: AGPL-3.0-only
//
// Add client, against a real database: `client.create` (C32) as the Clients
// page sends it makes a client that `client.list` then names and a new task
// can be put under; a person without `record:write` is refused it, and
// nothing is made.

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

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('client-create-then-file: DATABASE_URL is unset, so nothing below ran.');
}

type Body = Readonly<Record<string, unknown>>;

interface World {
  readonly db: FreshDatabase;
  readonly business: BusinessId;
  readonly owner: Member;
  /** A member with task grants and no `record:write`. */
  readonly staff: Member;
}

async function send(world: World, as: Member, body: Body) {
  return await executeCommand(world.db.app, world.business, as.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
}

async function listed(world: World, as: Member) {
  const read = await executeRead(world.db.app, world.business, as.presented, {
    read: 'client.list',
  } as never);
  if (isCommandRefusal(read) || !('clients' in read)) throw new Error('client.list refused');
  return (read.clients as readonly { clientId: string; name: string }[]).map((each) => each.name);
}

async function seed(): Promise<World> {
  const db = await createFreshDatabase({ part: 'clientadd' });
  const business = (await insertBusiness(db.app, 'clientadd-alpha')) as BusinessId;
  await installSpine(db.app, business);
  const owner = await enrol(db.app, business, 'owner');
  const staff = await enrol(db.app, business, 'staff');
  await db.app.withBusiness(business, async (tx) => {
    for (const member of [owner, staff])
      for (const action of ['read', 'write', 'share'] as const)
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, member, action);
    await grantTo(tx, owner, 'write', undefined, false, 'record');
  });
  return { db, business, owner, staff };
}

describe.skipIf(serverUrl === undefined)('Add client against a real database', () => {
  let world: World;

  beforeAll(async () => {
    world = await seed();
  }, 180_000);

  afterAll(async () => {
    await world?.db.drop();
  });

  it('a client made by client.create is listed and a new task can be put under it', async () => {
    const made = await send(world, world.owner, {
      command: 'client.create',
      name: 'Northgate Plumbing',
    });
    if (isCommandRefusal(made)) throw new Error(`client.create refused ${made.code}`);
    const clientId = (made.detail as { clientId: string }).clientId;
    expect(await listed(world, world.owner)).toContain('Northgate Plumbing');
    const task = await send(world, world.owner, {
      command: 'task.create',
      fields: { title: 'Quote the bathroom job' },
    });
    if (isCommandRefusal(task)) throw new Error(`task.create refused ${task.code}`);
    const filed = await send(world, world.owner, {
      command: 'task.set_party',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { client: clientId },
    });
    expect(isCommandRefusal(filed) ? filed.code : 'applied').toBe('applied');
    const read = await executeRead(world.db.app, world.business, world.owner.presented, {
      read: 'task.read',
      recordId: task.recordId ?? '',
    });
    if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
    expect(read.task).toMatchObject({ client: clientId });
  });

  it('a person without record:write is refused client.create, and nothing is made', async () => {
    const before = await listed(world, world.owner);
    const refused = await send(world, world.staff, {
      command: 'client.create',
      name: 'Coral Coast Yoga',
    });
    expect(isCommandRefusal(refused) ? refused.code : 'applied').toBe('SCOPE_NOT_GRANTED');
    expect(await listed(world, world.owner)).toStrictEqual(before);
  });
});
