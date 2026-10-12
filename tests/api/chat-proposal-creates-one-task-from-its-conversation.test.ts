// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's piece 2 against Postgres, on the stand-in model: custody's
// real process and the replay provider on loopback answer with a task block,
// and the server keeps that reply as words and writes nothing for it. The card
// reads it with the drawer's own parser and sends the drawer's own write
// (`proposalCreate`, `proposalEdit`) through the server's composition
// root. A create made twice under the reply's derived operation id is one
// task: it reads back by its key, lands on the board of tasks on no board, and
// names the conversation as its origin, so the conversation's wrap-up counts
// it among the tasks created. An edit applies to the chat's own task at the
// revision its question was asked at, once however often it is sent, and to
// no other task; a task changed since refuses it as stale (Sol F4, F5). Sol F3
// (the create's grant read before `originOf`'s lock) is #1507's, on every
// task.create, and is not answered here. The stored rows, read as admin, are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import type { ModelAnswer } from '../../packages/core-connectors/src/index.ts';
import { proposalCreate, proposalEdit, readProposal } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer, type ApiFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const block = (json: string): string => `Here is a task for that.\n\n\`\`\`task\n${json}\n\`\`\``;

interface Reply {
  readonly messageId: string;
  readonly body: string;
}

const replyOf = (answer: Answer): Reply => {
  const reply = (answer.body as Record<string, unknown>)['reply'] as Record<string, unknown>;
  return { messageId: String(reply['messageId']), body: String(reply['body']) };
};

// eslint-disable-next-line max-lines-per-function -- one world, the create and the edit on it
describe.skipIf(serverUrl === undefined)('chat proposal on the stand-in model', () => {
  let fixture: ApiFixture;
  let w: ConversationWorld;
  let model: LocalModel;
  /** What the stand-in model answers next. */
  let says = '';

  const tasksTitled = async (title: string): Promise<number> =>
    await w.count(`select count(*) as n from public.records where data->>'title' = $1`, [title]);

  const revisionOf = async (id: string): Promise<number> =>
    await w.count(`select revision as n from public.records where id = $1`, [id]);

  const make = async (title: string): Promise<{ id: string; revision: number }> => {
    const made = await w.as(w.owner, 'task.create', { fields: { title } });
    return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
  };

  /** A question in a conversation on task `id`, and the edit its reply proposes. */
  const asked = async (id: string) => {
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'Rename this for the next draft',
      scope: { kind: 'task', id },
    });
    const reply = replyOf(opened);
    return { reply, proposal: readProposal(reply.body).proposal };
  };

  /** The conversation the task's creation names as its origin. */
  const originOf = async (taskId: string): Promise<string | null | undefined> => {
    const [row] = await fixture.db.admin.execute<{ readonly origin: string | null }>(
      `select origin_conversation_id::text as origin from public.audit_events
        where subject_record_id = $1 and command = 'task.create' and outcome = 'applied'`,
      [taskId],
    );
    return row?.origin;
  };

  /** The conversation's wrap-up, written a quiet week on: its tasks created. */
  const tasksCreated = async (conversationId: string) => {
    await w.age(conversationId, 8);
    const wrapped = await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: 'chatproposal' }),
    );
    expect(wrapped).toMatchObject({ ok: true, written: true });
    const [row] = await fixture.db.admin.execute<{
      readonly items: readonly Record<string, unknown>[];
    }>(
      `select items from public.conversation_wrap_ups where conversation_id = $1 order by version desc limit 1`,
      [conversationId],
    );
    return row?.items.find((each) => each['key'] === 'tasks_created');
  };

  beforeAll(async () => {
    fixture = await createApiFixture('chat_proposal');
    model = await localModel((body: unknown): ModelAnswer | undefined =>
      typeof body === 'object' && body !== null
        ? {
            text: says,
            model: 'replay-1',
            usage: { inputUnits: 1, outputUnits: 1 },
            providerCode: null,
          }
        : undefined,
    );
    w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  }, 120_000);

  afterAll(async () => {
    await model?.close();
    await fixture?.drop();
  });

  it('a reply’s create is kept as words and writes nothing; the click, sent twice, is one task with its conversation as origin', async () => {
    says = block('{"action":"create","title":"Book the printer","description":"Two quotes."}');
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'We need the printer booked',
    });
    const conversationId = String(detail(opened)['conversationId']);
    const reply = replyOf(opened);
    const { proposal } = readProposal(reply.body);
    expect(proposal).toStrictEqual({
      action: 'create',
      title: 'Book the printer',
      description: 'Two quotes.',
    });
    // Nothing before the click.
    expect(await tasksTitled('Book the printer')).toBe(0);
    if (proposal === null) return;

    const write = proposalCreate(proposal, reply.messageId, conversationId);
    const first = await w.as(w.owner, 'task.create', {
      ...write.body,
      operationId: write.operationId,
    });
    const again = await w.as(w.owner, 'task.create', {
      ...write.body,
      operationId: write.operationId,
    });
    expect(first.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
    expect(await tasksTitled('Book the printer')).toBe(1);
    const taskId = String(first.body['recordId']);
    const key = String(detail(first)['key']);

    // By its key, as the card's link opens it.
    const read = await w.as(w.owner, 'task.read', { recordId: key });
    expect(read.body).toMatchObject({
      task: { id: taskId, title: 'Book the printer', description: 'Two quotes.' },
    });
    // Assigned to nobody, it lands with the tasks on no board.
    const board = await w.as(w.owner, 'task.board', { board: null });
    expect(board.status).toBe(200);
    expect(JSON.stringify(board.body)).toContain(taskId);
    // The creation names the conversation, so its wrap-up counts the task.
    expect(await originOf(taskId)).toBe(conversationId);
    const created = await tasksCreated(conversationId);
    expect(created?.['fact']).toBe('1 task created');
    expect(JSON.stringify(created?.['pointers'])).toContain(taskId);
  });

  it('a block’s due day and estimate land in the task’s Due and Estimate fields, not its description', async () => {
    says = block(
      '{"action":"create","title":"Draft the Riverbend newsletter","due":"2026-10-17","estimate":90}',
    );
    const opened = await w.as(w.owner, 'conversation.start', { body: 'Newsletter by Friday' });
    const conversationId = String(detail(opened)['conversationId']);
    const reply = replyOf(opened);
    const { proposal } = readProposal(reply.body);
    if (proposal === null) throw new Error('no create proposed');
    const write = proposalCreate(proposal, reply.messageId, conversationId);
    const made = await w.as(w.owner, 'task.create', {
      ...write.body,
      operationId: write.operationId,
    });
    expect(made.status).toBe(200);
    const read = await w.as(w.owner, 'task.read', { recordId: String(made.body['recordId']) });
    const task = (read.body as { readonly task: Record<string, unknown> }).task;
    expect(String(task['due'])).toMatch(/^2026-10-17/u);
    expect(task['estimateMinutes']).toBe(90);
    expect(task['description'] ?? null).toBeNull();
  });

  it('a reply’s edit applies to the chat’s own task at its question’s revision, once, and to no other task', async () => {
    const own = await make('Spring brief');
    const other = await make('Autumn brief');
    says = block('{"action":"edit","title":"Spring brief, second draft"}');
    const { reply, proposal } = await asked(own.id);
    expect(proposal?.action).toBe('edit');
    expect(await revisionOf(own.id)).toBe(own.revision);
    if (proposal === null) return;

    const write = proposalEdit(proposal, reply.messageId, {
      taskId: own.id,
      revision: own.revision,
    });
    const sent = {
      ...write.body,
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    };
    const applied = await w.as(w.owner, 'task.update', sent);
    // Its answer lost, the click goes again: the same attempt, replayed.
    const again = await w.as(w.owner, 'task.update', sent);
    expect(applied.status).toBe(200);
    expect(again.body).toStrictEqual(applied.body);
    expect(await revisionOf(own.id)).toBe(own.revision + 1);
    const read = await w.as(w.owner, 'task.read', { recordId: own.id });
    expect(read.body).toMatchObject({ task: { title: 'Spring brief, second draft' } });
    expect(await revisionOf(other.id)).toBe(other.revision);
    expect(await tasksTitled('Autumn brief')).toBe(1);
  });

  it('an edit whose task changed after the question is refused as stale and overwrites nothing', async () => {
    const own = await make('Winter brief');
    says = block('{"action":"edit","title":"Winter brief, from the chat"}');
    const { reply, proposal } = await asked(own.id);
    if (proposal === null) throw new Error('no edit proposed');
    // Newer work lands on the task before the click.
    const newer = await w.as(w.owner, 'task.update', {
      recordId: own.id,
      fields: { title: 'Winter brief, newer work' },
      expectedRevision: own.revision,
      operationId: randomUUID(),
    });
    expect(newer.status).toBe(200);
    const write = proposalEdit(proposal, reply.messageId, {
      taskId: own.id,
      revision: own.revision,
    });
    const stale = await w.as(w.owner, 'task.update', {
      ...write.body,
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    });
    expect(stale.body).toMatchObject({ code: 'VERSION_STALE' });
    const read = await w.as(w.owner, 'task.read', { recordId: own.id });
    expect(read.body).toMatchObject({ task: { title: 'Winter brief, newer work' } });
  });
});
