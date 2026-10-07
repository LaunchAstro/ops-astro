// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { wayfinderWorld, type Member, type WayfinderWorld } from './world.ts';

const needsDatabase = it.skipIf(databaseUrlFromEnvironment() === undefined);
const types = ['grilling', 'prototype'] as const;
let w: WayfinderWorld;
let owner: Member;
let writer: Member;
let teammate: Member;
let mapId: string;
let writerMapId: string;
let writerCredential: string;
let ownerCredential: string;

async function credentialFor(member: Member): Promise<string> {
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, member, 'write', WHOLE_BUSINESS, false, 'credential');
  });
  const answer = await w.as(member, {
    command: 'credential.issue',
    scope: [
      { collection: 'task', action: 'read' },
      { collection: 'task', action: 'write' },
    ],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    purpose: 'Create tasks for the person',
  });
  if (isCommandRefusal(answer)) throw new Error(`credential.issue refused ${answer.code}`);
  const credential = answer.detail['credential'];
  if (typeof credential !== 'string') throw new Error('credential.issue returned no credential');
  return credential;
}

beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('taskcreateowner', 'taskcreateowner');
  owner = await w.member('owner', ['read', 'write']);
  writer = await w.member('writer', ['read', 'write']);
  teammate = await w.decider('teammate');
  mapId = (await w.create(owner, { title: 'Owned map' }, { taskType: 'map' })).id;
  writerMapId = (await w.create(writer, { title: 'Writer map' }, { taskType: 'map' })).id;
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, owner, 'decide', { kind: 'record', id: mapId });
  });
  writerCredential = await credentialFor(writer);
  ownerCredential = await credentialFor(owner);
});

afterAll(async () => await w?.drop());

needsDatabase.each(types)(
  "a task writer cannot create a %s ticket on another person's map",
  async (taskType) => {
    const answer = await w.as(writer, {
      command: 'task.create',
      fields: { title: 'Requires a decision' },
      taskType,
      parentId: mapId,
    });
    expect(answer).toMatchObject({
      code: 'SCOPE_NOT_GRANTED',
      names: ['task:decide'],
      fixes: ['Filing a grilling or prototype ticket on a map needs task:decide.'],
    });
  },
);

needsDatabase.each(types)(
  "a teammate with decide cannot create a %s ticket on another person's map",
  async (taskType) => {
    const answer = await w.as(teammate, {
      command: 'task.create',
      fields: { title: 'Requires the owner' },
      taskType,
      parentId: mapId,
    });
    expect(answer).toMatchObject({
      code: 'SCOPE_NOT_GRANTED',
      names: ['map owner'],
      fixes: ["Only the map's owner files a grilling or prototype ticket on the map."],
    });
  },
);

needsDatabase.each(types)(
  'a map owner without decide cannot create a %s ticket on their map',
  async (taskType) => {
    const answer = await w.as(writer, {
      command: 'task.create',
      fields: { title: 'Requires decide' },
      taskType,
      parentId: writerMapId,
    });
    expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED', names: ['task:decide'] });
  },
);

needsDatabase.each(types)(
  "an agent credential cannot create a %s ticket on another person's map",
  async (taskType) => {
    const answer = await executeCredentialCommand(
      w.db.app,
      w.business,
      { credential: writerCredential, now: new Date() },
      {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'Requires a person to decide' },
        taskType,
        parentId: mapId,
      },
    );
    expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED', names: ['task:decide'] });
  },
);

needsDatabase.each(types)(
  "the map owner's agent credential cannot create a %s ticket using the person's decide grant",
  async (taskType) => {
    const answer = await executeCredentialCommand(
      w.db.app,
      w.business,
      { credential: ownerCredential, now: new Date() },
      {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'Requires the owner to decide' },
        taskType,
        parentId: mapId,
      },
    );
    expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED', names: ['task:decide'] });
  },
);

needsDatabase.each(types)(
  'the map owner with decide can create a %s ticket on their map',
  async (taskType) => {
    const made = await w.create(
      owner,
      { title: 'Owner files a ticket' },
      { taskType, parentId: mapId },
    );
    const answer = await w.read(owner, { read: 'map.view', recordId: mapId });
    expect(answer).toMatchObject({
      map: {
        tickets: expect.arrayContaining([
          expect.objectContaining({
            id: made.id,
            type: taskType,
            title: 'Owner files a ticket',
          }),
        ]),
      },
    });
  },
);
