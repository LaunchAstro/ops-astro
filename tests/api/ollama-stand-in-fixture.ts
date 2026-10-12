// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in Ollama on loopback for the side panel's race and hostile-answer
// cases, and the API's own broker started on it as `OPS_AGENT_PROVIDER=ollama`
// starts it. The stand-in records each `/api/chat` request, answers as a case
// tells it to (a finished chat, an error status, a socket closed mid-answer),
// and can hold every request at a gate until the case opens it, so a case
// decides when the model answers.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import { latch } from '../support/lock-wait-race.ts';

export interface Seen {
  readonly model: string;
  /** The person's words: the last turn. */
  readonly last: string;
  /** The whole request body, as sent. */
  readonly raw: string;
}

/** What the stand-in does with one request: answer with a status and body, or drop the socket mid-answer. */
export type Reply = { readonly status: number; readonly body: string } | 'close';

/** A finished chat from `model`, with `content` as its words. */
export const chatAnswer = (model: string, content: string): Reply => ({
  status: 200,
  body: JSON.stringify({
    model,
    message: { role: 'assistant', content },
    done: true,
    prompt_eval_count: 120,
    eval_count: 8,
  }),
});

/** The default: each model says who it is. */
export const says = (model: string): string => `${model} says: two tasks are due today.`;

export interface StandIn {
  readonly origin: string;
  readonly seen: Seen[];
  /** What each request gets, by the model it asks for; a case swaps it. */
  reply: (model: string) => Reply;
  /** Holds every request after it is recorded, until `open`. */
  shut(): void;
  open(): void;
  /** Resolves once `n` requests in all have been recorded. */
  arrived(n: number): Promise<void>;
  close(): Promise<void>;
}

function answerWith(response: ServerResponse, reply: Reply): void {
  if (reply === 'close') {
    // Headers and half a body, then the socket goes: an answer that never finishes.
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
    response.write('{"model":"qwen3.6:27b-mlx","message":{"role":"assistant","content":"Two');
    setTimeout(() => response.socket?.destroy(), 20);
    return;
  }
  response.statusCode = reply.status;
  response.setHeader('content-type', 'application/json');
  response.end(reply.body);
}

/** Polls the recorded requests until there are `n`. */
async function reached(seen: readonly Seen[], n: number): Promise<void> {
  for (let tries = 0; tries < 800 && seen.length < n; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls the recorded requests
    await sleep(10);
  }
  if (seen.length < n) throw new Error(`${String(n)} requests never reached the stand-in`);
}

export async function standInOllama(): Promise<StandIn> {
  const seen: Seen[] = [];
  let gate = latch();
  gate.open();
  const standIn: StandIn = {
    origin: '',
    seen,
    reply: (model) => chatAnswer(model, says(model)),
    shut: () => {
      gate = latch();
    },
    open: () => gate.open(),
    arrived: async (n) => await reached(seen, n),
    close: async () => await Promise.resolve(),
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      const body = JSON.parse(raw) as { model: string; messages: { content: string }[] };
      seen.push({ model: body.model, last: body.messages.at(-1)?.content ?? '', raw });
      const reply = standIn.reply(body.model);
      void gate.promise.then(() => answerWith(response, reply));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return Object.assign(standIn, {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      gate.open();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  });
}

/** The API's broker on `OPS_AGENT_PROVIDER=ollama`, over one local route to the stand-in. */
export async function ollamaBroker(
  origin: string,
): Promise<{ readonly exchange: ConversationExchange; stop(): Promise<void> }> {
  const folder = mkdtempSync(join(tmpdir(), 'ollama-race-'));
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
    MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'ollama', origin }]),
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
  return {
    exchange: broker.answerConversation,
    stop: async () => {
      await broker.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
