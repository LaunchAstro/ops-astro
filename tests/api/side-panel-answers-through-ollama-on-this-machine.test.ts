// SPDX-License-Identifier: AGPL-3.0-only
//
// The side panel on Ollama, end to end through the API's own composition
// root: `OPS_AGENT_PROVIDER=ollama` and the broker's four settings start
// custody, and a person's message is answered by the model on this machine
// (here a stand-in Ollama on loopback), kept as the agent's reply. The call is
// recorded on a local route with nothing held, the model the person picked is
// the one asked, and a model Ollama does not have answers in fixed words with
// nothing kept. No client's conversation is offered either model, whatever
// the client's setting says: Ollama is for internal work only.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Seen {
  readonly path: string;
  readonly model: string;
  readonly last: string;
}

const ANSWERED = (model: string): string =>
  JSON.stringify({
    model,
    message: { role: 'assistant', content: `${model} says: two tasks are due today.` },
    done: true,
    prompt_eval_count: 180,
    eval_count: 12,
  });

/** One `/api/chat` request: recorded, then answered for a model it has, 404 for any other. */
function chat(seen: Seen[], has: ReadonlySet<string>): RequestListener {
  return (request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    request.on('end', () => {
      const body = JSON.parse(text) as { model: string; messages: { content: string }[] };
      const last = body.messages.at(-1)?.content ?? '';
      seen.push({ path: request.url ?? '', model: body.model, last });
      response.setHeader('content-type', 'application/json');
      if (has.has(body.model)) {
        response.end(ANSWERED(body.model));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: `model '${body.model}' not found` }));
    });
  };
}

/** A stand-in Ollama on loopback, with the two models offered. */
async function standInOllama(): Promise<{
  readonly origin: string;
  readonly seen: Seen[];
  readonly has: Set<string>;
  close(): Promise<void>;
}> {
  const seen: Seen[] = [];
  const has = new Set(['qwen3.6:27b-mlx', 'gemma4:31b-mlx']);
  const server: Server = createServer(chat(seen, has));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    seen,
    has,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const replyOf = (answer: { readonly body: unknown }): unknown =>
  (answer.body as Record<string, unknown>)['reply'];

// eslint-disable-next-line max-lines-per-function -- one broker and one world, asked in turn
describe.skipIf(serverUrl === undefined)('the side panel on Ollama', () => {
  let ollama: Awaited<ReturnType<typeof standInOllama>>;
  let folder: string;
  let stopBroker: () => Promise<void>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    folder = mkdtempSync(join(tmpdir(), 'ollama-side-panel-'));
    const credentialsFile = join(folder, 'credentials.json');
    writeFileSync(
      credentialsFile,
      JSON.stringify([
        {
          ref: 'ollama_key',
          kind: 'api_key',
          account: 'm5-ollama',
          destination: 'ollama',
          header: 'authorization',
          value: `local-${String(Date.now())}`,
        },
      ]),
      { mode: 0o600 },
    );
    const settings = brokerSettings({
      OPS_AGENT_PROVIDER: 'ollama',
      MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
      MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'ollama', origin: ollama.origin }]),
      MODEL_BROKER_ROUTES: JSON.stringify([
        {
          key: 'm5_ollama',
          reach: 'local',
          provider: 'ollama',
          credentialRef: 'ollama_key',
          credentialKind: 'api_key',
          installation: 'here',
          ceiling: 4,
        },
      ]),
      MODEL_BROKER_INSTALLATION: 'here',
    });
    if (settings.kind !== 'configured') throw new Error(`broker ${settings.kind}`);
    const broker = await startModelBroker(settings);
    stopBroker = broker.stop;
    const fixture = await createApiFixture('ollama_side_panel');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.answerConversation) });
  }, 180_000);

  afterAll(async () => {
    await stopBroker?.();
    await ollama?.close();
    await w?.drop();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('offers Qwen and Gemma in the picker', async () => {
    const read = await w.as(w.owner, 'conversation.models', {});
    expect(read.status).toBe(200);
    const models = (read.body as { models: { id: string; reach: string }[] }).models;
    expect(models.map((model) => [model.id, model.reach])).toStrictEqual([
      ['qwen3.6:27b-mlx', 'local'],
      ['gemma4:31b-mlx', 'local'],
    ]);
  });

  it("answers the owner's message on Qwen by default, kept as the agent's reply with nothing held", async () => {
    const opened = await w.as(w.owner, 'conversation.start', { body: 'What is due today?' });
    expect(opened.status).toBe(200);
    expect(replyOf(opened)).toMatchObject({
      answered: true,
      body: 'qwen3.6:27b-mlx says: two tasks are due today.',
    });
    expect(ollama.seen.at(-1)).toStrictEqual({
      path: '/api/chat',
      model: 'qwen3.6:27b-mlx',
      last: 'What is due today?',
    });
    const rows = await w.fixture.db.admin.execute<Record<string, unknown>>(
      `select route_reach, provider, state, reserved_minor::int as reserved, actual_minor::int as actual
         from public.model_calls where conversation_id is not null`,
      [],
    );
    expect(rows).toEqual([
      { route_reach: 'local', provider: 'ollama', state: 'settled', reserved: 0, actual: 0 },
    ]);
  });

  it('asks Gemma once the person picks it', async () => {
    const id = await started(w, w.owner, { body: 'Hello' });
    const set = await w.as(w.owner, 'conversation.set_model', {
      conversationId: id,
      model: 'gemma4:31b-mlx',
    });
    expect(set.status).toBe(200);
    const next = await w.as(w.owner, 'conversation.message', {
      conversationId: id,
      body: 'And tomorrow?',
    });
    expect(replyOf(next)).toMatchObject({
      answered: true,
      body: 'gemma4:31b-mlx says: two tasks are due today.',
    });
    expect(ollama.seen.at(-1)).toMatchObject({ model: 'gemma4:31b-mlx', last: 'And tomorrow?' });
  });

  it('a model taken off this machine answers in fixed words and keeps nothing', async () => {
    const id = await started(w, w.owner, { body: 'Hello again' });
    ollama.has.delete('qwen3.6:27b-mlx');
    try {
      const next = await w.as(w.owner, 'conversation.message', {
        conversationId: id,
        body: 'Still there?',
      });
      expect(replyOf(next)).toMatchObject({ answered: false });
      expect(JSON.stringify(next.body)).not.toContain('not found');
      expect(ollama.seen.at(-1)).toMatchObject({ model: 'qwen3.6:27b-mlx', last: 'Still there?' });
      expect(
        await w.count(
          `select count(*)::text as n from public.conversation_messages
            where conversation_id = $1 and role = 'agent'`,
          [id],
        ),
      ).toBe(1);
    } finally {
      ollama.has.add('qwen3.6:27b-mlx');
    }
  });

  it("offers no model on a client's task, even with the client's model use on", async () => {
    const { db, business } = w.fixture;
    const clientId = randomUUID();
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    await addClient(db.app, business, clientId, w.owner);
    await db.admin.execute(
      'update public.clients set model_egress = true, model_providers = $2 where id = $1',
      [clientId, ['claude', 'chatgpt', 'replay']],
    );
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'a client’s task' } });
    const placed = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    expect(placed.status).toBe(200);
    const before = ollama.seen.length;
    const id = await started(w, w.owner, {
      body: 'How is this client going?',
      scope: { kind: 'task', id: String(made.body['recordId']) },
    });
    const read = await w.as(w.owner, 'conversation.models', { conversationId: id });
    expect((read.body as { models: unknown[] }).models).toStrictEqual([]);
    const set = await w.as(w.owner, 'conversation.set_model', {
      conversationId: id,
      model: 'gemma4:31b-mlx',
    });
    expect(set.status).toBe(422);
    expect(ollama.seen).toHaveLength(before);
  });
});
