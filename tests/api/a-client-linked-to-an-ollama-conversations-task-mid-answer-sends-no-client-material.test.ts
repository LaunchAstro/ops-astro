// SPDX-License-Identifier: AGPL-3.0-only
//
// Ollama serves internal work only: no client's conversation is offered
// either model (`offeredModels`), and owner line 72 refuses a client's page
// to any model (`conversation-context.ts`). Here the client is linked to the
// conversation's page task by `task.set_party` while a question on it is in
// flight, with Gemma chosen for the conversation:
//
// - while the exchange reads the page: the link holds the task's row, the
//   exchange waits on it (both seen in `pg_stat_activity`), sees the client
//   once the link commits, and asks no model. The title never reaches Ollama.
// - while Ollama has the question: what was sent was an internal task's title
//   (never its id), asked before the link. From the link on, the
//   conversation is a client's: the picker offers nothing, Gemma is refused,
//   and the next question asks no model.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';
import { ollamaBroker, says, standInOllama, type StandIn } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const GEMMA = 'gemma4:31b-mlx';

// eslint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('a client linked to the page task mid-answer', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin);
    // The API answers nothing; the case calls the exchange on a connection of its own.
    const fixture = await createApiFixture('ollama_client_race');
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  /** Waits until `n` backends wait on a lock the backend `pid` holds, or behind one that does. */
  async function waitingOnLocks(n: number): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const found = await w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (found >= n) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await sleep(10);
    }
    throw new Error(`${String(n)} backends never waited on the task's row`);
  }

  /** An internal task, a conversation on it with Gemma chosen, and a question kept on it. */
  async function gemmaOnATask(title: string) {
    const made = await w.as(w.owner, 'task.create', { fields: { title } });
    const taskId = String(made.body['recordId']);
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'What is this?',
      scope: { kind: 'task', id: taskId },
      model: GEMMA,
    });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    const clientId = randomUUID();
    await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
    const link = async (): Promise<Answer> =>
      await w.as(w.owner, 'task.set_party', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: made.body['revision'],
        fields: { client: clientId },
      });
    return { taskId, asked, link };
  }

  it('a link committed while the exchange waits on the page asks no model', async () => {
    const { db, business } = w.fixture;
    const title = `Soon a client's ${randomUUID()}`;
    const { taskId, asked, link } = await gemmaOnATask(title);
    const before = ollama.seen.length;
    // The holder stands where `task.set_party` takes the task's row: the link waits
    // behind it, and the exchange behind the link.
    const holder = await holdRow(
      db,
      'select id from public.records where business_id = $1 and id = $2 for update',
      [business, taskId],
    );
    const reader = connect(db.appUrl, { source: 'runtime' });
    let linking: Promise<Answer> | undefined;
    let answering: Promise<ConversationReply | null> | undefined;
    try {
      linking = link();
      await waitingOnLocks(1);
      answering = broker.exchange(reader, business, w.owner.presented, asked);
      await waitingOnLocks(2);
      await holder.letGo();
      expect((await linking).status).toBe(200);
      const reply = await answering;
      expect(reply).toMatchObject({ answered: false });
      expect(['CLIENT_MODEL_USE_OFF', 'MODEL_NOT_OFFERED']).toContain(
        (reply as { code: string }).code,
      );
      expect(ollama.seen).toHaveLength(before);
      expect(JSON.stringify(ollama.seen)).not.toContain(title);
      expect(
        await w.count(
          `select count(*)::text as n from public.model_calls where conversation_id = $1`,
          [asked.conversationId],
        ),
      ).toBe(0);
    } finally {
      await holder.letGo();
      await linking?.catch(() => null);
      await answering?.catch(() => null);
      await reader.close();
    }
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- one schedule, then each door the client's conversation shuts
  it('a link committed while Ollama answers: from then on the conversation reaches no model', async () => {
    const { db, business } = w.fixture;
    const title = `Internal for now ${randomUUID()}`;
    const { taskId, asked, link } = await gemmaOnATask(title);
    const before = ollama.seen.length;
    const reader = connect(db.appUrl, { source: 'runtime' });
    let answering: Promise<ConversationReply | null> | undefined;
    ollama.shut();
    try {
      answering = broker.exchange(reader, business, w.owner.presented, asked);
      await ollama.arrived(before + 1);
      // What went out was an internal task's title, never its id, to the model chosen.
      const sent = ollama.seen[before];
      expect(sent?.model).toBe(GEMMA);
      expect(sent?.raw).toContain(title);
      expect(sent?.raw).not.toContain(taskId);
      expect((await link()).status).toBe(200);
      ollama.open();
      // The answer to a question asked of an internal task, kept on the person's own conversation.
      expect(await answering).toMatchObject({ answered: true, body: says(GEMMA) });
      // From the link on: nothing offered, Gemma refused, and the next question asks nothing.
      const offer = await w.as(w.owner, 'conversation.models', {
        conversationId: asked.conversationId,
      });
      expect((offer.body as { models: unknown[] }).models).toStrictEqual([]);
      const chosen = await w.as(w.owner, 'conversation.set_model', {
        conversationId: asked.conversationId,
        model: GEMMA,
      });
      expect(chosen.status).toBe(422);
      const next = await w.as(w.owner, 'conversation.message', {
        conversationId: asked.conversationId,
        body: 'And now?',
      });
      const later = await broker.exchange(reader, business, w.owner.presented, {
        conversationId: asked.conversationId,
        messageId: String(detail(next)['messageId']),
      });
      expect(later).toMatchObject({ answered: false });
      expect(ollama.seen).toHaveLength(before + 1);
      expect(
        await w.count(
          `select count(*)::text as n from public.conversation_messages
            where conversation_id = $1 and role = 'agent'`,
          [asked.conversationId],
        ),
      ).toBe(1);
    } finally {
      ollama.open();
      await answering?.catch(() => null);
      await reader.close();
    }
  }, 60_000);
});
