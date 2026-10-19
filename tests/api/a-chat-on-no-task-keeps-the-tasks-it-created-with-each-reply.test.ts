// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666 against Postgres, through the server's composition root and the
// stand-in model on loopback (`chat-created-fixture.ts`). In a chat opened on
// no task:
//
// - each reply is kept with its snapshot: the tasks the conversation created
//   that the asker could use, each at the revision read, and the model is told
//   only that there are some, never an id;
// - the card's edit, sent at the snapshot's revision, changes that task; one
//   changed since is refused as stale, and a task the person cannot write is
//   refused with the server's own reason;
// - a retry, a twin request on another composition root and the conversation's
//   read all give the snapshot the reply was kept with, never one rebuilt;
// - only the conversation's owner is given targets, and only those they may
//   use now, by their kept place, never renumbered.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { proposalEdit, readProposal } from '../../packages/core-wire/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { CONVERSATION } from './aw-03-fixture.ts';
import { block, chatWorld, lastSeen, type ChatWorld } from './chat-created-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, each leg of a chat editing what it created
describe.skipIf(serverUrl === undefined)('a chat on no task keeps the tasks it created', () => {
  let c: ChatWorld;

  beforeAll(async () => {
    c = await chatWorld('chat_created_edits');
  }, 180_000);

  afterAll(async () => {
    await c?.close();
  });

  it('create, then change it: the reply carries the created task at its revision, the model is told only that the chat created tasks, and the card’s edit changes that task', async () => {
    const { conversationId, task } = await c.created(c.w.owner, 'Book the printer');
    c.state.says = block('{"action":"edit","title":"Book the printer for Friday"}');
    const { reply } = await c.say(c.w.owner, conversationId, 'Make that Friday');
    const revision = await c.revisionOf(task);
    expect(reply.targets).toStrictEqual({ pick: false, tasks: [{ n: 1, taskId: task, revision }] });
    expect(lastSeen(c.model).fields['page']).toBe(JSON.stringify({ created: true }));
    expect(lastSeen(c.model).body).not.toContain(task);
    const proposal = readProposal(reply.body).proposal;
    if (proposal === null) throw new Error('no edit proposed');
    const write = proposalEdit(proposal, reply.messageId, { taskId: task, revision });
    const applied = await c.w.as(c.w.owner, 'task.update', {
      ...write.body,
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    });
    expect(applied.status).toBe(200);
    const read = await c.w.as(c.w.owner, 'task.read', { recordId: task });
    expect(read.body).toMatchObject({ task: { title: 'Book the printer for Friday' } });
  });

  it('a chat that created two tasks gives both, in creation order, and asks the person to pick', async () => {
    const { conversationId, task: first } = await c.created(c.w.owner, 'Order paper');
    c.state.says = block('{"action":"create","title":"Order ink"}');
    const { reply: second } = await c.say(c.w.owner, conversationId, 'And ink');
    const ink = await c.click(c.w.owner, conversationId, second);
    c.state.says = block('{"action":"edit","title":"Order more"}');
    const { reply } = await c.say(c.w.owner, conversationId, 'Make it more');
    expect(reply.targets).toStrictEqual({
      pick: true,
      tasks: [
        { n: 1, taskId: first, revision: await c.revisionOf(first) },
        { n: 2, taskId: ink, revision: await c.revisionOf(ink) },
      ],
    });
  });

  it('a task changed between the reply and the click keeps the reply’s target and is refused as stale', async () => {
    const { conversationId, task } = await c.created(c.w.owner, 'Draft the flyer');
    c.state.says = block('{"action":"edit","title":"Draft the flyer, v2"}');
    const { reply } = await c.say(c.w.owner, conversationId, 'Call it v2');
    const kept = await c.revisionOf(task);
    const moved = await c.w.as(c.w.owner, 'task.update', {
      recordId: task,
      fields: { title: 'Draft the flyer, newer' },
      expectedRevision: kept,
      operationId: randomUUID(),
    });
    expect(moved.status).toBe(200);
    expect(reply.targets).toStrictEqual({
      pick: false,
      tasks: [{ n: 1, taskId: task, revision: kept }],
    });
    const proposal = readProposal(reply.body).proposal;
    if (proposal === null) throw new Error('no edit proposed');
    const write = proposalEdit(proposal, reply.messageId, { taskId: task, revision: kept });
    const stale = await c.w.as(c.w.owner, 'task.update', {
      ...write.body,
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    });
    expect(stale.body).toMatchObject({ code: 'VERSION_STALE' });
  });

  it('a lost reply is answered again with the snapshot it was kept with, even after the chat creates another task', async () => {
    const { conversationId, task } = await c.created(c.w.owner, 'Hire a van');
    c.state.says = block('{"action":"edit","title":"Hire a big van"}');
    const operationId = randomUUID();
    const first = await c.say(c.w.owner, conversationId, 'A big one', operationId);
    c.state.says = block('{"action":"create","title":"Hire a driver"}');
    const later = await c.say(c.w.owner, conversationId, 'And a driver');
    await c.click(c.w.owner, conversationId, later.reply);
    const again = await c.say(c.w.owner, conversationId, 'A big one', operationId);
    expect(again.reply).toStrictEqual(first.reply);
    expect(again.reply.targets).toStrictEqual({
      pick: false,
      tasks: [{ n: 1, taskId: task, revision: expect.any(Number) as number }],
    });
  });

  it('two exchanges answering one question at once, on separate composition roots, keep one reply and one snapshot, and give both the same', async () => {
    const { conversationId, task } = await c.created(c.w.owner, 'Book a room');
    c.state.says = block('{"action":"edit","title":"Book a bigger room"}');
    c.state.quiet = true;
    const { messageId } = await c.say(c.w.owner, conversationId, 'A bigger one');
    c.state.quiet = false;
    const asked = { conversationId, messageId };
    const { db, business } = c.fixture;
    const [a, raced] = await Promise.all([
      c.model.exchange(db.app, business, c.w.owner.presented, asked),
      c.other.exchange(db.app, business, c.w.owner.presented, asked),
    ]);
    // A twin told the call is still answering asks again once it is kept.
    const b =
      raced?.answered === false && raced.code === 'STILL_ANSWERING'
        ? await c.other.exchange(db.app, business, c.w.owner.presented, asked)
        : raced;
    expect(a).toStrictEqual(b);
    expect(a).toMatchObject({ targets: { pick: false, tasks: [{ n: 1, taskId: task }] } });
    expect(
      await c.w.count(
        `select count(*)::int as n from public.conversation_reply_snapshots s
           join public.conversation_messages m on m.id = s.message_id
          where m.answers_message_id = $1`,
        [messageId],
      ),
    ).toBe(1);
    // A fresh root reads the kept one back, unchanged.
    expect(await c.other.exchange(db.app, business, c.w.owner.presented, asked)).toStrictEqual(a);
  });

  it('a task this conversation did not create is never a target: one made outside the chat, one made by another conversation, one by another person’s', async () => {
    const outside = await c.w.as(c.w.owner, 'task.create', {
      fields: { title: 'Made on the board' },
    });
    const elsewhere = await c.created(c.w.owner, 'Another chat’s task');
    const { who } = await c.member('neighbour');
    const theirs = await c.created(who, 'Their task');
    const { conversationId, task } = await c.created(c.w.owner, 'Only mine');
    c.state.says = block('{"action":"edit","title":"Only mine, renamed"}');
    const { reply } = await c.say(c.w.owner, conversationId, 'Rename it');
    expect(reply.targets).toStrictEqual({
      pick: false,
      tasks: [{ n: 1, taskId: task, revision: await c.revisionOf(task) }],
    });
    const named = JSON.stringify(reply.targets);
    for (const foreign of [String(outside.body['recordId']), elsewhere.task, theirs.task]) {
      expect(named).not.toContain(foreign);
    }
  });

  it('a target the owner can read but not write is offered, and its click is refused with the server’s reason', async () => {
    const { who, write: writes } = await c.member('reader');
    const { conversationId, task } = await c.created(who, 'Look but no touch');
    c.state.says = block('{"action":"edit","title":"Touched"}');
    const { reply } = await c.say(who, conversationId, 'Rename it');
    expect(reply.targets).toMatchObject({ tasks: [{ n: 1, taskId: task }] });
    const { db, business } = c.fixture;
    // The write goes; the read stays.
    await db.app.withBusiness(business, async (tx) => await revokeGrant(tx, writes));
    const proposal = readProposal(reply.body).proposal;
    if (proposal === null) throw new Error('no edit proposed');
    const revision = await c.revisionOf(task);
    const write = proposalEdit(proposal, reply.messageId, { taskId: task, revision });
    const refused = await c.w.as(who, 'task.update', {
      ...write.body,
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ refused: true });
    expect((refused.body['fixes'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('only the owner is given targets: a business-wide conversation reader with no task read gets none', async () => {
    const { conversationId } = await c.created(c.w.owner, 'Owner’s own');
    c.state.says = block('{"action":"edit","title":"Owner’s own, renamed"}');
    await c.say(c.w.owner, conversationId, 'Rename it');
    const { db, business } = c.fixture;
    const reader = await enrol(db.app, business, `conv-reader-${randomUUID().slice(0, 8)}`);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, reader, 'read', undefined, false, CONVERSATION);
    });
    const theirs = await c.w.as(reader, 'conversation.read', { conversationId });
    expect(theirs.status).toBe(200);
    const messages = theirs.body['messages'] as Record<string, unknown>[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((message) => 'targets' in message)).toBe(false);
    const own = await c.w.as(c.w.owner, 'conversation.read', { conversationId });
    const kept = (own.body['messages'] as Record<string, unknown>[]).filter((m) => 'targets' in m);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('a target the owner can no longer read is left out of their read and their replay, keeping the others’ places and the pick', async () => {
    const { who, read } = await c.member('two-tasks');
    const { conversationId, task: first } = await c.created(who, 'First of two');
    c.state.says = block('{"action":"create","title":"Second of two"}');
    const { reply: made } = await c.say(who, conversationId, 'And another');
    const second = await c.click(who, conversationId, made);
    c.state.says = block('{"action":"edit","title":"Renamed"}');
    const operationId = randomUUID();
    const { reply } = await c.say(who, conversationId, 'Rename one', operationId);
    expect(reply.targets).toMatchObject({ pick: true, tasks: [{ n: 1 }, { n: 2 }] });
    const { db, business } = c.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await revokeGrant(tx, read);
      await grantTo(tx, who, 'read', { kind: 'record', id: second });
    });
    const shown = {
      pick: true,
      tasks: [{ n: 2, taskId: second, revision: expect.any(Number) as number }],
    };
    const reread = await c.w.as(who, 'conversation.read', { conversationId });
    const kept = (reread.body['messages'] as Record<string, unknown>[]).find(
      (message) => message['id'] === reply.messageId,
    );
    expect(kept?.['targets']).toStrictEqual(shown);
    expect(JSON.stringify(reread.body)).not.toContain(first);
    const replayed = await c.say(who, conversationId, 'Rename one', operationId);
    expect(replayed.reply.targets).toStrictEqual(shown);
  });
});
