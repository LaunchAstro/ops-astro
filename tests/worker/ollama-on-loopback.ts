// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in Ollama on loopback for the model agent's own cases, which open no
// database: it counts each chat it parses whole (a connection with no request
// written is not one), and streams a chat as Ollama does, holding after the
// first `holdAfter` chunks until the case resumes it.

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Streamed {
  readonly status: number;
  readonly chunks: readonly string[];
  readonly holdAfter?: number;
  /** Each chunk is bytes spelled as Latin-1, so a case can cut a character in two. */
  readonly latin1?: boolean;
}

export interface LoopbackOllama {
  readonly origin: string;
  /** Each chat parsed, as sent. */
  readonly seen: string[];
  reply: (model: string) => Streamed;
  /** Resolves once a streamed answer has written the chunks before its hold. */
  midway(): Promise<void>;
  resume(): void;
  /** Resolves once `n` chats in all have been parsed. */
  arrived(n: number): Promise<void>;
  close(): Promise<void>;
}

/** A streamed chat from `model`: one NDJSON line per word, then the last line with the counts. */
export function streamedLines(model: string, words: readonly string[]): string[] {
  const line = (content: string, done: boolean): string =>
    `${JSON.stringify({
      model,
      message: { role: 'assistant', content },
      done,
      ...(done ? { done_reason: 'stop', prompt_eval_count: 120, eval_count: words.length } : {}),
    })}\n`;
  return [...words.map((word) => line(word, false)), line('', true)];
}

const nothing = (): void => {};

/** A promise opened by hand. */
function opener(): { promise: Promise<void>; open: () => void } {
  let open = nothing;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface Holds {
  halfway: ReturnType<typeof opener>;
  resumed: ReturnType<typeof opener>;
}

/** Writes a streamed answer, holding after its first `holdAfter` chunks. */
async function stream(response: ServerResponse, answer: Streamed, holds: Holds): Promise<void> {
  response.writeHead(answer.status, { 'content-type': 'application/x-ndjson' });
  for (const [at, chunk] of answer.chunks.entries()) {
    if (at === answer.holdAfter) {
      holds.halfway.open();
      await holds.resumed.promise; // oxlint-disable-line no-await-in-loop
    }
    response.write(chunk, answer.latin1 === true ? 'latin1' : 'utf8');
  }
  response.end();
}

export async function ollamaOnLoopback(): Promise<LoopbackOllama> {
  const seen: string[] = [];
  const holds: Holds = { halfway: opener(), resumed: opener() };
  const reply: { current: (model: string) => Streamed } = {
    current: (model) => ({ status: 200, chunks: streamedLines(model, ['Two tasks.']) }),
  };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      seen.push(raw);
      void stream(response, reply.current((JSON.parse(raw) as { model: string }).model), holds);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    seen,
    get reply() {
      return reply.current;
    },
    set reply(next) {
      reply.current = next;
    },
    midway: async () => await holds.halfway.promise,
    resume: () => {
      holds.resumed.open();
      holds.halfway = opener();
      holds.resumed = opener();
    },
    arrived: async (n) => {
      for (let tries = 0; tries < 800 && seen.length < n; tries += 1) await sleep(10); // oxlint-disable-line no-await-in-loop
    },
    close: async () => {
      holds.resumed.open();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
