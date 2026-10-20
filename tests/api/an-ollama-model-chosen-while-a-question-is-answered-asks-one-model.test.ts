// SPDX-License-Identifier: AGPL-3.0-only
//
// The model a conversation runs on (Qwen or Gemma, CS-7.30) changed by
// `conversation.set_model` while a question on that conversation is being
// answered by Ollama. The exchange reads the choice once, in its first
// transaction, and asks exactly that one model: the stand-in sees one
// request, for one model, and the reply kept, the call's recorded model and
// what the stand-in was asked all agree, though the call's row, keyed to the
// conversation, waits for the choice to commit. The new choice is the one the
// next question asks. Through the API's own broker and a stand-in Ollama on
// loopback, the choice written by `conversation.set_model` itself, its wait
// on the conversation's row seen in `pg_stat_activity`.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';
import { ollamaBroker, says, standInOllama, type StandIn } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QWEN = 'qwen3.6:35b-mlx';
const GEMMA = 'gemma4:31b-mlx';

// eslint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('an Ollama model chosen mid-answer', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin);
    // The API answers nothing; the case calls the exchange on a connection of its own.
    const fixture = await createApiFixture('ollama_model_race');
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  /** Waits until `n` backends wait on a lock the backend `pid` holds (any lock, for null). */
  async function waitingOn(pid: number | null, n: number): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const found = await w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and ($1::int is null or $1::int = any(pg_blocking_pids(pid)))`,
        [pid],
      );
      if (found >= n) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await sleep(10);
    }
    throw new Error(`${String(n)} backends never waited on the conversation's row`);
  }

  async function question(body: string, model?: string) {
    const opened = await w.as(w.owner, 'conversation.start', {
      body,
      ...(model === undefined ? {} : { model }),
    });
    return {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
  }

  /** The model the call recorded, and the conversation's choice now. */
  async function recorded(conversationId: string) {
    const [row] = await w.fixture.db.admin.execute<{ call: string | null; chosen: string | null }>(
      `select (select string_agg(model_id, ',') from public.model_calls
                where conversation_id = c.id) as call, c.model_id as chosen
         from public.conversations c where c.id = $1`,
      [conversationId],
    );
    return row;
  }

  it('Gemma chosen while a question is read: Qwen is asked, and its answer, call and reply agree', async () => {
    const { db, business } = w.fixture;
    const asked = await question('What is due today?');
    const before = ollama.seen.length;
    // The holder stands where a message or the purge holds the conversation's row.
    const holder = await holdRow(
      db,
      'select id from public.conversations where id = $1 for update',
      [asked.conversationId],
    );
    const reader = connect(db.appUrl, { source: 'runtime' });
    let choosing: Promise<Answer> | undefined;
    let answering: Promise<ConversationReply | null> | undefined;
    ollama.shut();
    try {
      choosing = w.as(w.owner, 'conversation.set_model', {
        conversationId: asked.conversationId,
        model: GEMMA,
      });
      await waitingOn(holder.pid, 1);
      // The choice is not committed: the exchange reads the default. Its call's row
      // (keyed to the conversation) then queues on the row behind the choice.
      answering = broker.exchange(reader, business, w.owner.presented, asked);
      await waitingOn(null, 2);
      expect(ollama.seen).toHaveLength(before);
      await holder.letGo();
      await ollama.arrived(before + 1);
      ollama.open();
      expect((await choosing).status).toBe(200);
      expect(await answering).toMatchObject({ answered: true, body: says(QWEN) });
      expect(ollama.seen.slice(before).map((one) => one.model)).toStrictEqual([QWEN]);
      expect(await recorded(asked.conversationId)).toEqual({ call: QWEN, chosen: GEMMA });
      // The next question asks the model now chosen.
      const next = await w.as(w.owner, 'conversation.message', {
        conversationId: asked.conversationId,
        body: 'And tomorrow?',
      });
      await broker.exchange(reader, business, w.owner.presented, {
        conversationId: asked.conversationId,
        messageId: String(detail(next)['messageId']),
      });
      expect(ollama.seen.at(-1)).toMatchObject({ model: GEMMA, last: 'And tomorrow?' });
    } finally {
      ollama.open();
      await holder.letGo();
      await choosing?.catch(() => null);
      await answering?.catch(() => null);
      await reader.close();
    }
  }, 60_000);

  it('the default chosen while Gemma is answering: the reply is Gemma’s, recorded as Gemma’s', async () => {
    const { db, business } = w.fixture;
    const asked = await question('Draft the week', GEMMA);
    const before = ollama.seen.length;
    const reader = connect(db.appUrl, { source: 'runtime' });
    let answering: Promise<ConversationReply | null> | undefined;
    ollama.shut();
    try {
      answering = broker.exchange(reader, business, w.owner.presented, asked);
      await ollama.arrived(before + 1);
      // Committed while the model has the question in hand.
      const set = await w.as(w.owner, 'conversation.set_model', {
        conversationId: asked.conversationId,
        model: null,
      });
      expect(set.status).toBe(200);
      ollama.open();
      expect(await answering).toMatchObject({ answered: true, body: says(GEMMA) });
      expect(ollama.seen.slice(before).map((one) => one.model)).toStrictEqual([GEMMA]);
      expect(await recorded(asked.conversationId)).toEqual({ call: GEMMA, chosen: null });
    } finally {
      ollama.open();
      await answering?.catch(() => null);
      await reader.close();
    }
  }, 60_000);
});
