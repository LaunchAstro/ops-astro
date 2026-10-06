// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G, team conversations' group half, over the real HTTP routes: each test
// is named after its ticket line. A group conversation is a thread on the one
// comment record whose audience is its members (`group`), started by
// `chat.start_group` under `chat:comment`; its creator, or a member holding
// `chat:manage` (the owner and administrators), renames it and changes its
// members. Only a member reads or writes it, and no client or agent is ever
// one. The cast is `c71-g-world.ts`'s.

// oxlint-disable no-await-in-loop -- one caller at a time, each read back
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalCommentProjection } from '../../packages/core-records/src/index.ts';
import type { StoredComment } from '../../packages/core-records/src/index.ts';
import type { Caller } from '../acceptance/cast.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createGroupWorld, detailOf, type Body, type GroupWorld } from './c71-g-world.ts';

// eslint-disable-next-line max-lines-per-function -- one world, the ticket's lines
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-G group conversations', () => {
  let g: GroupWorld;

  beforeAll(async () => {
    g = await createGroupWorld('c71g');
  }, 180_000);

  afterAll(async () => {
    await g?.chat.harness.close();
  });

  it('CS-7.41 start a group conversation with chosen teammates and name it: each of them sees it arrive and can reply; the audience is the member list, held on the one comment record', async () => {
    const { chat, canary, groupName, conversationId, say, viewOf, bodiesOf } = g;
    const { world } = chat.harness;
    const everyone = [chat.tess.personId, world.ada.personId, world.mia.personId].toSorted();
    for (const who of [world.ada, world.mia]) {
      const view = await viewOf(who);
      expect(view).toMatchObject({ kind: 'group', name: groupName, unread: 1 });
      expect(view?.members.toSorted()).toEqual(everyone);
    }
    const reply = await say(world.mia, 'a reply');
    expect(reply.status, reply.text).toBe(200);
    expect(await bodiesOf(world.ada)).toEqual([canary, 'a reply']);
    const [row] = await world.db.admin.execute<{ readonly key: string; readonly data: Body }>(
      `select t.key, r.data from public.records r
         join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        where r.id = $1`,
      [detailOf(reply)['commentId']],
    );
    expect(row?.key).toBe('task_comment');
    expect(row?.data).toMatchObject({ audience: 'group', conversation: conversationId });
    expect(row?.data['task']).toBeUndefined();
    const [group] = await world.db.admin.execute<{ readonly data: Body }>(
      `select data from public.records where id = $1`,
      [conversationId],
    );
    expect(group?.data).toMatchObject({
      chat_kind: 'group',
      chat_name: groupName,
      chat_creator: chat.tess.personId,
    });
    // The body is in the comment record and nowhere else.
    expect(await chat.holding(canary)).toEqual(['public.records']);
  });

  it('a group needs a name and two or more teammates, each staff of this business: a client, an agent and an outsider are never a member', async () => {
    const { chat, as, start, auditOf } = g;
    const { world } = chat.harness;
    const [outsider] = await world.db.admin.execute<{ readonly id: string }>(
      `select p.id from public.people p where p.business_id = $1 and not exists (
         select 1 from public.memberships m where m.person_id = p.id and m.active) limit 1`,
      [world.alpha],
    );
    const mates = [world.ada.personId, world.mia.personId];
    const before = await auditOf('chat.start_group');
    for (const [members, code] of [
      [[world.ada.personId], 'FIELD_VALUE_INVALID'],
      [[world.ada.personId, world.ada.personId], 'FIELD_VALUE_INVALID'],
      [[chat.tess.personId, world.ada.personId], 'FIELD_VALUE_INVALID'],
      ['not a list', 'FIELD_VALUE_INVALID'],
      [[...mates, String(outsider?.id)], 'NOT_FOUND'],
      [[...mates, world.agent.actorId], 'NOT_FOUND'],
      [[...mates, world.bea.personId], 'NOT_FOUND'],
      [[...mates, randomUUID()], 'NOT_FOUND'],
    ] as const) {
      const answer = await as(chat.tess, 'chat.start_group', { name: 'no', members });
      expect(answer.code, `${JSON.stringify(members)} ${answer.text}`).toBe(code);
    }
    for (const name of ['', '   ', 'x'.repeat(81), 'tab\there']) {
      expect((await start(chat.tess, mates, name)).code, JSON.stringify(name)).toBe(
        'FIELD_VALUE_INVALID',
      );
    }
    const after = await auditOf('chat.start_group');
    expect(after.slice(before.length).map((e) => e.outcome)).toEqual(
      Array.from({ length: 12 }, () => 'refused'),
    );
    const [kinds] = await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.records where data ->> 'chat_name' = 'no'`,
    );
    expect(kinds?.n).toBe('0');
  });

  it('only a member reads or writes a group conversation, and no client or agent does: a refusal for each', async () => {
    const { chat, zed, canary, groupName, conversationId, as, asAgent, viewOf } = g;
    const { world, clients } = chat.harness;
    const upTo = new Date().toISOString();
    const named = [
      ['chat.messages', { conversationId }],
      ['chat.send_group', { conversationId, body: 'from outside' }],
      ['chat.mark_read', { conversationId, upTo }],
      ['chat.rename_group', { conversationId, name: 'taken over' }],
      ['chat.change_members', { conversationId, add: [zed.personId] }],
      ['chat.leave', { conversationId }],
    ] as const;
    // Zed, staff holding `chat:comment`, is not a member: as for an id never issued.
    expect(await viewOf(zed)).toBeUndefined();
    for (const [name, body] of named) {
      const answer = await as(zed, name, body);
      expect(answer.code, `${name} ${answer.text}`).toBe('NOT_FOUND');
      expect(answer.text).not.toContain(canary);
    }
    // A client of the business, refused every one, starting one included.
    const client = clients.find((one) => one.businessKey === 'alpha');
    for (const [name, body] of [
      ...named,
      ['chat.start_group', { name: 'clients', members: [world.ada.personId, world.mia.personId] }],
    ] as const) {
      const answer = await as({ token: String(client?.token) }, name, body);
      expect(answer.body['refused'], `${name} ${answer.text}`).toBe(true);
      expect(answer.text).not.toContain(canary);
    }
    // An agent, before a pickup and under a live delegation.
    const credential = await chat.agentCredential();
    for (const asked of [undefined, credential]) {
      for (const [name, body] of [
        ...named,
        ['chat.start_group', { name: 'agents', members: [world.ada.personId, world.mia.personId] }],
      ] as const) {
        const answer = await asAgent(name, body, asked);
        expect(answer.body['refused'], `${name} ${answer.text}`).toBe(true);
        expect(answer.text).not.toContain(canary);
      }
    }
    expect(await chat.holding('from outside')).toEqual([]);
    expect((await viewOf(world.ada))?.name).toBe(groupName);
  });

  it('only its creator, or the owner and administrators, changes its members or name: the conversation renamed and the members changed are audited', async () => {
    const { chat, groupName, conversationId, as, viewOf, auditOf } = g;
    const { world } = chat.harness;
    // Mia, a member holding `chat:comment` alone, did not start it.
    for (const [name, body] of [
      ['chat.rename_group', { conversationId, name: 'mine now' }],
      ['chat.change_members', { conversationId, remove: [world.ada.personId] }],
    ] as const) {
      const answer = await as(world.mia, name, body);
      expect(answer.code, `${name} ${answer.text}`).toBe('SCOPE_NOT_GRANTED');
    }
    // Its creator renames it; an administrator in it renames it back.
    const byCreator = await as(chat.tess, 'chat.rename_group', {
      conversationId,
      name: 'Renamed by Tess',
    });
    expect(byCreator.status, byCreator.text).toBe(200);
    expect((await viewOf(world.mia))?.name).toBe('Renamed by Tess');
    const byAdmin = await as(world.ada, 'chat.rename_group', { conversationId, name: groupName });
    expect(byAdmin.status, byAdmin.text).toBe(200);
    expect((await viewOf(world.mia))?.name).toBe(groupName);
    const outcomes = async (who: Caller) =>
      (await auditOf('chat.rename_group', who.actorId)).map((e) => e.outcome);
    expect([
      await outcomes(world.mia),
      await outcomes(chat.tess),
      await outcomes(world.ada),
    ]).toEqual([['refused'], ['applied'], ['applied']]);
    // No name, no change of members, nobody's audit row holds the words.
    for (const event of await auditOf('chat.rename_group')) {
      expect(event.t).not.toContain('Renamed by Tess');
    }
  });

  it('an administrator not in a group renames it and changes who else is in it, and still reads, lists and joins nothing of it', async () => {
    const { chat, zed, as, start, viewOf, bodiesOf } = g;
    const { world } = chat.harness;
    const other = await start(chat.tess, [world.mia.personId, zed.personId], 'Without Ada');
    const otherId = String(detailOf(other)['conversationId']);
    const renamedByAdmin = await as(world.ada, 'chat.rename_group', {
      conversationId: otherId,
      name: 'Named by Ada',
    });
    expect(renamedByAdmin.status, renamedByAdmin.text).toBe(200);
    expect((await viewOf(world.mia, otherId))?.name).toBe('Named by Ada');
    const removedByAdmin = await as(world.ada, 'chat.change_members', {
      conversationId: otherId,
      remove: [zed.personId],
    });
    expect(removedByAdmin.status, removedByAdmin.text).toBe(200);
    expect((await viewOf(world.mia, otherId))?.members).not.toContain(zed.personId);
    const selfAdded = await as(world.ada, 'chat.change_members', {
      conversationId: otherId,
      add: [world.ada.personId],
    });
    expect(selfAdded.code, selfAdded.text).toBe('FIELD_VALUE_INVALID');
    expect(await viewOf(world.ada, otherId)).toBeUndefined();
    expect(await bodiesOf(world.ada, otherId)).toEqual([]);
  });

  it('a group message is never a task’s and never shown outside: task.comment refuses the audience and the client projection drops it', async () => {
    const { chat, canary } = g;
    const { alphaTask } = chat.harness;
    const answer = await chat.harness.asPerson('task.comment', {
      recordId: alphaTask.id,
      expectedRevision: alphaTask.revision,
      body: 'misaddressed',
      audience: 'group',
    });
    expect(answer.code).toBe('FIELD_VALUE_INVALID');
    const group = { id: randomUUID(), audience: 'group', body: canary } as unknown as StoredComment;
    expect(externalCommentProjection([group], [])).toEqual([]);
  });
});
