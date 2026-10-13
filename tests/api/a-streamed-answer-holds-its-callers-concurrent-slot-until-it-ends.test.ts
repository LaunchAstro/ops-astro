// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's calls at once are counted until each has answered (API-3), and a
// live stream holds its slot until the stream ends. An answer written as a
// stream is still being answered after the response begins: the database
// work, the model's answer and the settle all run on. So its slot is held
// until the stream ends, as the JSON answer holds it until it returns. With
// one call at a time allowed, a second call while either is answered is
// refused, and once the answer ends the next is admitted.

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { QUOTAS } from '../../packages/core-records/src/identity/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { authorised, createApiFixture, ISSUER, post, tokenFor } from './fixture.ts';
import { personPath } from './controls-fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { sendStreaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('a streamed answer holds its caller’s slot', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;
  let oneAtATime: Hono;
  let conversationId: string;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('stream_holds_slot');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    conversationId = await started(w, w.owner, { body: 'Hello?' });
    oneAtATime = composeApi({
      keys: runtimeKeys({ ...fixture.environment }),
      database: fixture.db.app,
      admin: fixture.db.admin,
      signIn: testSignIn(ISSUER),
      executeRead,
      answerConversation: broker.exchange,
      quota: { limits: { ...QUOTAS, concurrent: { credential: 1, person: 1, business: 128 } } },
    }).app;
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const read = async () =>
    await post(
      oneAtATime,
      personPath('conversation.read'),
      { conversationId },
      authorised(await tokenFor(w.owner.presented.subject)),
    );

  it('JSON: a second call while the answer is written is refused', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 2 });
    const answering = post(
      oneAtATime,
      personPath('conversation.message'),
      { operationId: randomUUID(), conversationId, body: 'What is due?' },
      authorised(await tokenFor(w.owner.presented.subject)),
    );
    await ollama.midway();
    const second = await read();
    ollama.resume();
    expect((await answering).status).toBe(200);
    expect(second.body).toMatchObject({ refused: true, code: 'QUOTA_EXCEEDED' });
    expect((await read()).status).toBe(200);
  }, 60_000);

  it('stream: a second call while the answer is written is refused too', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 2 });
    const streaming = await sendStreaming(oneAtATime, w.owner, 'conversation.message', {
      conversationId,
      body: 'And tomorrow?',
    });
    await ollama.midway();
    expect((await streaming.next())?.event).toBe('piece');
    const second = await read();
    ollama.resume();
    const events = await streaming.rest();
    expect(events.at(-1)?.event).toBe('outcome');
    expect(second.body).toMatchObject({ refused: true, code: 'QUOTA_EXCEEDED' });
    expect((await read()).status).toBe(200);
  }, 60_000);
});
