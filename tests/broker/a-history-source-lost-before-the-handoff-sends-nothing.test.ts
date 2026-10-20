// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666: an earlier exchange whose card created a task carries that task's
// words in the history a later question sends. The task is judged with the
// context and again at the handoff: given a client after the context was read
// and before the send, the paid send is not admitted (nothing goes, the hold
// is freed), and on a carried deployment the send judgement stops it (nothing
// is sent, nothing kept).

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Custody } from '../../packages/core-custody/src/custody.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import type { ConversationWorld } from '../api/aw-03-fixture.ts';
import { carriedWorld, type CarriedWorld } from '../api/carried-world.ts';
import { HAIKU } from '../api/openrouter-stand-in-fixture.ts';
import { sendStreaming } from '../api/streamed-reply-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A task created from the reply `replyId`'s card in the conversation, and a way to give it a client. */
async function createdFrom(
  w: ConversationWorld,
  owner: Member,
  conversationId: string,
  replyId: string,
) {
  const made = await w.as(owner, 'task.create', {
    fields: { title: `Plan ${randomUUID()}` },
    conversationId,
    operationId: `task-proposal:${replyId}`,
  });
  expect(made.status).toBe(200);
  const task = String(made.body['recordId']);
  const client = randomUUID();
  const { db, business } = w.fixture;
  await addClient(db.app, business, client, owner);
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, owner, 'share');
  });
  const link = async (): Promise<void> => {
    const own = connect(db.appUrl, { source: 'runtime' });
    try {
      const placed = await executeCommand(own, business, owner.presented, 'api', {
        command: 'task.set_party',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: made.body['revision'],
        fields: { client },
      } as never);
      expect(placed).toMatchObject({ recordId: task });
    } finally {
      await own.close();
    }
  };
  return { task, link };
}

// eslint-disable-next-line max-lines-per-function -- one world, the lost source and its control
describe.skipIf(serverUrl === undefined)('a history source lost before the paid handoff', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('history_source_paid');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('a task an earlier card created, given a client after the context read and before the handoff: nothing sent, the hold freed', async () => {
    const first = await p.question('Make a task for the plan');
    const reply = await p.ask(first);
    if (reply?.answered !== true) throw new Error('the first question was not answered');
    const { link } = await createdFrom(p.w, p.w.owner, first.conversationId, reply.messageId);
    const asked = await p.next(first.conversationId, 'And next?');
    const { db, business } = p.w.fixture;
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    const exchange = await p.twin((broker) => {
      const custody: Custody = broker.custody;
      return {
        ...broker,
        custody: {
          ...custody,
          dispatch: async (ref, request, onPiece, admit) => {
            await link();
            return await custody.dispatch(ref, request, onPiece, admit);
          },
        },
      };
    });
    expect(await exchange(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: false,
      code: 'CUSTODY_NOT_ADMITTED',
    });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.committed()).toBe(before);
  });

  it('with the task still the asker’s, the same question is sent once', async () => {
    const first = await p.question('Make another task');
    const reply = await p.ask(first);
    if (reply?.answered !== true) throw new Error('the first question was not answered');
    await createdFrom(p.w, p.w.owner, first.conversationId, reply.messageId);
    const sent = p.openrouter.received.length;
    expect(await p.ask(await p.next(first.conversationId, 'And next?'))).toMatchObject({
      answered: true,
    });
    expect(p.openrouter.received.length).toBe(sent + 1);
  });
});

describe.skipIf(serverUrl === undefined)('a history source lost before the carried send', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('history_source_carried', undefined, {}, true);
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  it('a task an earlier card created, given a client after the offer and before the send: nothing sent, nothing kept', async () => {
    const { w } = world;
    const opened = await sendStreaming(world.api, w.owner, 'conversation.start', {
      body: 'Make a task for the plan',
      model: HAIKU,
    });
    const events = await opened.rest();
    const { reply, conversationId } = JSON.parse(events.at(-1)?.data ?? '{}') as {
      reply?: { messageId?: string };
      conversationId?: string;
    };
    const conversation =
      conversationId ??
      (
        await w.fixture.db.admin.execute<{ readonly id: string }>(
          `select conversation_id as id from public.conversation_messages where id = $1`,
          [String(reply?.messageId)],
        )
      )[0]?.id;
    const { link } = await createdFrom(w, w.owner, String(conversation), String(reply?.messageId));
    const sentBefore = world.agent.sent.length;
    world.agent.beforeAccept = async () => await link();
    const next = await sendStreaming(world.api, w.owner, 'conversation.message', {
      conversationId: conversation,
      body: 'And next?',
    });
    const after = await next.rest();
    expect(world.agent.sent).toHaveLength(sentBefore);
    expect(JSON.parse(after.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
  }, 60_000);
});
