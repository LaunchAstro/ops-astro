// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation opened on a client's page, with no task scope, carries the
// client's name as its subject and, untitled, as its title. That name reaches
// a person other than the owner only through a business-wide
// `conversation:read` grant, and any business-wide grant already reaches every
// client of the business (`clientsReached`, which `client.list` serves). A
// reader held to one task, to that client, or to another client, and a member
// of another business, are refused with nothing of the name.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { addClient, enrol, grantTo, type Member } from '../commands/fixture.ts';
import { serverUrl } from '../acceptance/world.ts';

let w: ConversationWorld;
let elsewhere: ConversationWorld;

const reader = async (name: string, scope: Parameters<typeof grantTo>[3]): Promise<Member> => {
  const member = await enrol(w.fixture.db.app, w.fixture.business, name);
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, member, 'read', scope, false, 'conversation');
  });
  return member;
};

/** The crossings refused with nothing of the name, then the one reader it reaches. */
async function nameReachesOnlyWideReaders(): Promise<void> {
  const [one, two] = [randomUUID(), randomUUID()];
  await addClient(w.fixture.db.app, w.fixture.business, one, w.owner);
  await addClient(w.fixture.db.app, w.fixture.business, two, w.owner);
  const name = `client ${one}`;
  const task = await w.as(w.owner, 'task.create', { fields: { title: 'a readable task' } });
  expect(task.status).toBe(200);
  const conversationId = await started(w, w.owner, { subject: name, body: 'How is it going?' });

  const crossings: readonly (readonly [string, Member, ConversationWorld])[] = [
    [
      'a reader held to one task',
      await reader('task_reader', { kind: 'record', id: String(task.body['recordId']) }),
      w,
    ],
    ['a reader held to that client', await reader('client_reader', { kind: 'party', id: one }), w],
    [
      'a reader held to another client',
      await reader('other_client_reader', { kind: 'party', id: two }),
      w,
    ],
    ['a member of another business', elsewhere.colleague, elsewhere],
  ];
  for (const [who, member, world] of crossings) {
    // oxlint-disable-next-line no-await-in-loop -- each crossing is asked in turn
    const answer = await world.as(member, 'conversation.read', { conversationId });
    expect([403, 404], who).toContain(answer.status);
    expect(JSON.stringify(answer.body), who).not.toContain(one);
  }

  const wide = await reader('business_reader', { kind: 'business', id: null });
  const read = await w.as(wide, 'conversation.read', { conversationId });
  expect(read.status).toBe(200);
  expect(read.body['conversation']).toMatchObject({ subject: name, title: name });
  // The same grant already lists that client, name and all.
  const clients = await w.as(wide, 'client.list', {});
  expect(clients.status).toBe(200);
  expect(clients.body['clients']).toContainEqual({ clientId: one, name });
}

describe.skipIf(serverUrl === undefined)('a conversation naming a client', () => {
  beforeAll(async () => {
    w = await conversationWorld('convclientname');
    elsewhere = await conversationWorld('convclientnameother');
  }, 180_000);
  afterAll(async () => {
    await w?.drop();
    await elsewhere?.drop();
  });

  it('reaches a non-owner only through a business-wide conversation read grant', async () => {
    await nameReachesOnlyWideReaders();
  });
});
