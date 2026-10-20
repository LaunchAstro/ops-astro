// SPDX-License-Identifier: AGPL-3.0-only
//
// A person who closes the panel while the answer is still being written loses
// only the provisional text. The server carries on: the answer settles, the
// reply is kept, and the next read of the conversation shows it. Ollama is
// asked once.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { openedWhileWriting, sendStreaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('a browser that leaves mid-answer', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('browser_leaves_mid_answer');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const kept = async (conversationId: string): Promise<readonly Record<string, unknown>[]> =>
    await w.fixture.db.admin.execute<Record<string, unknown>>(
      `select body from public.conversation_messages
        where conversation_id = $1 and role = 'agent' order by created_at`,
      [conversationId],
    );

  it('keeps the reply after the stream is gone, and the next read shows it', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Hello.']) });
    const opened = await w.as(w.owner, 'conversation.start', { body: 'Hello?' });
    const conversationId = String(detail(opened)['conversationId']);
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 1 });
    const asked = ollama.seen.length;
    const sending = sendStreaming(w.api, w.owner, 'conversation.message', {
      conversationId,
      body: 'What is due today?',
    });
    await ollama.midway();
    const streaming = await openedWhileWriting(sending);
    if (streaming === undefined) ollama.resume();
    expect(streaming, 'the stream opens while Ollama is still writing').toBeDefined();
    expect((await streaming?.next())?.event).toBe('piece');
    await streaming?.leave();
    ollama.resume();
    let rows = await kept(conversationId);
    for (let tries = 0; tries < 300 && rows.length < 2; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the server to finish without the browser
      await sleep(20);
      // oxlint-disable-next-line no-await-in-loop -- reads again after each wait
      rows = await kept(conversationId);
    }
    expect(rows.map((row) => row['body'])).toContain('Two tasks are due today.');
    const read = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(JSON.stringify(read.body)).toContain('Two tasks are due today.');
    expect(ollama.seen.length - asked).toBe(1);
  }, 60_000);
});
