// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-D, team conversations' direct half, over the real HTTP routes: each
// test is named after its ticket line. A direct message is a comment on the
// one comment record (audience `direct`, anchored to the pair's conversation),
// sent by `chat.send_direct` under `chat:comment` and audited as `comment
// created (audience: direct)`; the reader's marker (`chat.mark_read`) is their
// own and not audited; only the two members read or write it, and no client
// or agent does.

// oxlint-disable no-await-in-loop -- one caller at a time, each read back
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalCommentProjection } from '../../packages/core-records/src/index.ts';
import type { StoredComment } from '../../packages/core-records/src/index.ts';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';

type Body = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one world, the ticket's lines
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-D direct messages', () => {
  let chat: ChatWorld;
  const canary = `canary-${randomUUID()}`;
  let conversationId: string;
  let commentId: string;

  const conversationsOf = async (who: Parameters<ChatWorld['as']>[0]) =>
    (await chat.as(who, 'chat.conversations')).body['conversations'] as ChatConversationView[];
  const viewOf = async (who: Parameters<ChatWorld['as']>[0]) => {
    const all = await conversationsOf(who);
    return all.find((one) => one.conversationId === conversationId);
  };
  const messagesOf = async (who: Parameters<ChatWorld['as']>[0]) =>
    (await chat.as(who, 'chat.messages', { conversationId })).body['messages'] as ChatMessageView[];
  const auditOf = async (command: string, actorId: string | null) =>
    await chat.harness.world.db.admin.execute<{ readonly outcome: string; readonly t: string }>(
      `select outcome, e::text as t from public.audit_events e
        where command = $1 and actor_id = $2 order by seq`,
      [command, actorId],
    );

  beforeAll(async () => {
    chat = await createChatWorld('c71d');
    const { ada, mia } = chat.harness.world;
    const sent = await chat.send(ada, mia, canary);
    expect(sent.status, sent.text).toBe(200);
    const detail = sent.body['detail'] as Body;
    conversationId = String(detail['conversationId']);
    commentId = String(detail['commentId']);
  }, 180_000);

  afterAll(async () => {
    await chat?.harness.close();
  });

  it('CS-7.26 send a direct message: a comment with a two-person audience on the one comment record, through the comment command; no other table or store holds message bodies', async () => {
    const { world } = chat.harness;
    const [row] = await world.db.admin.execute<{ readonly key: string; readonly data: Body }>(
      `select t.key, r.data from public.records r
         join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        where r.id = $1`,
      [commentId],
    );
    expect(row?.key).toBe('task_comment');
    expect(row?.data).toMatchObject({ audience: 'direct', conversation: conversationId });
    expect(row?.data['task']).toBeUndefined();
    const members = await world.db.admin.execute<{ readonly person_id: string }>(
      `select person_id from public.team_conversation_members where conversation_id = $1`,
      [conversationId],
    );
    expect(members.map((m) => m.person_id).toSorted()).toEqual(
      [world.ada.personId, world.mia.personId].toSorted(),
    );
    // The pair has one conversation, whichever of them writes.
    const back = await chat.send(world.mia, world.ada, 'and back');
    expect((back.body['detail'] as Body)['conversationId']).toBe(conversationId);
    // The body is in the comment record and nowhere else: not the audit chain,
    // not the conversation, not the members, not the live stream.
    expect(await chat.holding(canary)).toEqual(['public.records']);
  });

  it('the command that causes each tracked action writes it in the same transaction, and appends it to the audit chain: comment created (audience: direct), with no body', async () => {
    const { ada } = chat.harness.world;
    const events = await auditOf('chat.send_direct', ada.actorId);
    expect(events.map((e) => e.outcome)).toEqual(['applied']);
    expect(events[0]?.t).not.toContain(canary);
    // A refused send writes nothing and is audited refused.
    const empty = await chat.send(ada, chat.harness.world.mia, '   ');
    expect(empty.code).toBe('FIELD_VALUE_INVALID');
    expect((await auditOf('chat.send_direct', ada.actorId)).map((e) => e.outcome)).toEqual([
      'applied',
      'refused',
    ]);
  });

  it('CS-7.25 opening a thread moves the person’s read marker, unread is derived from last read, and the marker adds no audit event (TR-S-B3-1)', async () => {
    const { ada, mia } = chat.harness.world;
    // A send moves the sender's own marker: Ada has Mia's reply unread, and
    // Mia, who replied after Ada's first, has only the newest.
    const adaView = (await conversationsOf(ada)).find((c) => c.conversationId === conversationId);
    expect(adaView?.unread).toBe(1);
    const fresh = await chat.send(ada, mia, 'one more');
    expect(fresh.status).toBe(200);
    const miaView = (await conversationsOf(mia)).find((c) => c.conversationId === conversationId);
    expect(miaView).toMatchObject({ kind: 'direct', name: null, unread: 1 });
    expect(miaView?.members.toSorted()).toEqual([ada.personId, mia.personId].toSorted());
    const messages = await messagesOf(mia);
    expect(messages.map((m) => m.body)).toEqual([canary, 'and back', 'one more']);
    expect(messages[0]).toMatchObject({ authorId: ada.personId });
    // Up to the first moves nothing (never back); up to the newest, none left.
    const at = (n: number): string => String(messages[n]?.at);
    for (const [upTo, unread] of [
      [at(0), 1],
      [at(2), 0],
      [at(0), 0],
    ] as const) {
      const marked = await chat.as(mia, 'chat.mark_read', { conversationId, upTo });
      expect(marked.status, marked.text).toBe(200);
      expect((await viewOf(mia))?.unread).toBe(unread);
    }
    expect(await auditOf('chat.mark_read', mia.actorId)).toEqual([]);
    const bad = await chat.as(mia, 'chat.mark_read', { conversationId, upTo: 'yesterday-ish' });
    expect(bad.code).toBe('FIELD_VALUE_INVALID');
  });

  it('only the two people in a direct conversation can read or write it, and no agent can: a third person, a client and an agent are refused', async () => {
    const { world, clients } = chat.harness;
    const { tess } = chat;
    // A third person, staff holding `chat:comment`: not listed, not read, not marked.
    expect(await conversationsOf(tess)).toEqual([]);
    expect((await chat.as(tess, 'chat.messages', { conversationId })).code).toBe('NOT_FOUND');
    const upTo = new Date().toISOString();
    expect((await chat.as(tess, 'chat.mark_read', { conversationId, upTo })).code).toBe(
      'NOT_FOUND',
    );
    // Writing to oneself, or to a client's person, is not a teammate.
    expect((await chat.send(world.ada, world.ada, 'me')).code).toBe('NOT_FOUND');
    const [outsider] = await world.db.admin.execute<{ readonly id: string }>(
      `select p.id from public.people p where p.business_id = $1 and not exists (
         select 1 from public.memberships m where m.person_id = p.id and m.active) limit 1`,
      [world.alpha],
    );
    expect((await chat.send(world.ada, String(outsider?.id), 'to a client')).code).toBe(
      'NOT_FOUND',
    );
    // A client: refused every one, naming nothing.
    const client = clients.find((one) => one.businessKey === 'alpha');
    for (const [name, body] of [
      ['chat.send_direct', { teammateId: world.ada.personId, body: 'hello' }],
      ['chat.conversations', {}],
      ['chat.messages', { conversationId }],
      ['chat.mark_read', { conversationId, upTo }],
    ] as const) {
      const answer = await chat.as({ token: String(client?.token) }, name, body);
      expect(answer.body['refused'], `${name} ${answer.text}`).toBe(true);
      expect(answer.text).not.toContain(canary);
    }
    // An agent, before a pickup and under a live delegation.
    const credential = await chat.agentCredential();
    for (const asked of [undefined, credential]) {
      for (const [name, body] of [
        ['chat.send_direct', { teammateId: world.mia.personId, body: 'from an agent' }],
        ['chat.conversations', {}],
        ['chat.messages', { conversationId }],
      ] as const) {
        const answer = await chat.harness.asAgent(name, body, asked);
        expect(answer.body['refused'], `${name} ${answer.text}`).toBe(true);
        expect(answer.text).not.toContain(canary);
      }
    }
    expect(await chat.holding('from an agent')).toEqual([]);
  });

  it('a member reads nothing written after they left, and is not counted unread for it', async () => {
    const { world } = chat.harness;
    const { ada, mia } = world;
    await world.db.admin.execute(
      `update public.team_conversation_members set left_at = now()
        where conversation_id = $1 and person_id = $2`,
      [conversationId, mia.personId],
    );
    const before = await messagesOf(mia);
    expect((await chat.send(ada, mia, 'after she left')).status).toBe(200);
    expect(await messagesOf(mia)).toEqual(before);
    const view = (await conversationsOf(mia)).find((c) => c.conversationId === conversationId);
    expect(view?.unread).toBe(0);
  });

  it('a direct message is never a task’s and never shown outside: task.comment refuses the audience and the client projection drops it', async () => {
    const { alphaTask } = chat.harness;
    const answer = await chat.harness.asPerson('task.comment', {
      recordId: alphaTask.id,
      expectedRevision: alphaTask.revision,
      body: 'misaddressed',
      audience: 'direct',
    });
    expect(answer.code).toBe('FIELD_VALUE_INVALID');
    const direct = { id: commentId, audience: 'direct', body: canary } as unknown as StoredComment;
    expect(externalCommentProjection([direct], [])).toEqual([]);
  });
});
