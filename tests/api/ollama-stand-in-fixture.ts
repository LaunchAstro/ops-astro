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
  /** The credential header it came with, if any. */
  readonly authorization: string | undefined;
}

/**
 * What the stand-in does with one request: answer with a status and body, drop
 * the socket mid-answer, or stream `chunks` as Ollama streams a chat, holding
 * after the first `holdAfter` of them until the case calls `resume`, and
 * dropping the socket after them where `cut` says so.
 */
export type Reply = { readonly status: number; readonly body: string } | 'close' | Streamed;

export interface Streamed {
  readonly status: number;
  readonly chunks: readonly string[];
  readonly holdAfter?: number;
  /** The socket goes after the last chunk, so the answer never finishes. */
  readonly cut?: boolean;
  /** Each chunk is bytes spelled as Latin-1, so a case can cut a character in two. */
  readonly latin1?: boolean;
}

/** A streamed chat from `model`: one NDJSON line per word, then the last line with the counts. */
export function streamedLines(model: string, words: readonly string[]): string[] {
  const piece = (content: string, done: boolean): string =>
    `${JSON.stringify({
      model,
      message: { role: 'assistant', content },
      done,
      ...(done ? { done_reason: 'stop', prompt_eval_count: 120, eval_count: words.length } : {}),
    })}\n`;
  return [...words.map((word) => piece(word, false)), piece('', true)];
}

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
  /** Resolves once a streamed answer has written the chunks before its hold. */
  midway(): Promise<void>;
  /** Lets a streamed answer held midway write the rest. */
  resume(): void;
  /** Resolves once `n` requests in all have been recorded. */
  arrived(n: number): Promise<void>;
  close(): Promise<void>;
}

async function streamWith(
  response: ServerResponse,
  reply: Streamed,
  hold: { readonly reached: () => void; readonly resumed: Promise<void> },
): Promise<void> {
  response.writeHead(reply.status, { 'content-type': 'application/x-ndjson' });
  for (const [at, chunk] of reply.chunks.entries()) {
    if (at === reply.holdAfter) {
      hold.reached();
      // oxlint-disable-next-line no-await-in-loop -- the hold is between two writes
      await hold.resumed;
    }
    response.write(chunk, reply.latin1 === true ? 'latin1' : 'utf8');
  }
  if (reply.cut === true) setTimeout(() => response.socket?.destroy(), 20);
  else response.end();
}

function answerWith(
  response: ServerResponse,
  reply: Reply,
  hold: { readonly reached: () => void; readonly resumed: Promise<void> },
): void {
  if (typeof reply === 'object' && 'chunks' in reply) {
    void streamWith(response, reply, hold);
    return;
  }
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

// oxlint-disable-next-line max-lines-per-function -- the stand-in and its controls
export async function standInOllama(): Promise<StandIn> {
  const seen: Seen[] = [];
  let gate = latch();
  gate.open();
  let halfway = latch();
  let resumed = latch();
  const standIn: StandIn = {
    origin: '',
    seen,
    reply: (model) => chatAnswer(model, says(model)),
    shut: () => {
      gate = latch();
    },
    open: () => gate.open(),
    midway: async () => {
      await halfway.promise;
    },
    resume: () => {
      resumed.open();
      halfway = latch();
      resumed = latch();
    },
    arrived: async (n) => await reached(seen, n),
    close: async () => await Promise.resolve(),
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      const body = JSON.parse(raw) as { model: string; messages: { content: string }[] };
      seen.push({
        model: body.model,
        last: body.messages.at(-1)?.content ?? '',
        raw,
        authorization: request.headers.authorization,
      });
      const reply = standIn.reply(body.model);
      const hold = { reached: halfway.open, resumed: resumed.promise };
      void gate.promise.then(() => answerWith(response, reply, hold));
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
      resumed.open();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  });
}

/** Ollama's credential as `docs/local/OLLAMA.md` files it: presented as nothing. */
const NONE = {
  ref: 'ollama_key',
  kind: 'api_key',
  account: 'm5-ollama',
  destination: 'ollama',
  scheme: 'none',
};

/**
 * The API's broker on `OPS_AGENT_PROVIDER=ollama`, over one local route to the
 * stand-in, its credential a local token unless `none` asks for none.
 */
// oxlint-disable-next-line max-lines-per-function -- the credential file, the settings and the broker
export async function ollamaBroker(
  origin: string,
  credential: 'token' | 'none' = 'token',
): Promise<{ readonly exchange: ConversationExchange; stop(): Promise<void> }> {
  const folder = mkdtempSync(join(tmpdir(), 'ollama-race-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      credential === 'none'
        ? NONE
        : {
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
  const broker = await startModelBroker(settings).catch((error: unknown) => {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  });
  return {
    exchange: broker.answerConversation,
    stop: async () => {
      await broker.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
