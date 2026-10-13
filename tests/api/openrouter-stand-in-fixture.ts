// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in OpenRouter on loopback for the paid chat's cases. No case calls
// OpenRouter. It records every request with its headers, answers as a case
// tells it to (an answer, an error status, a socket closed mid-answer), can
// hold every request at a gate until the case opens it, and runs a case's
// `onReceipt` before it answers, so a case can read the rows on another
// connection at the moment a request arrives.
//
// An answer here is the body custody hands the broker for OpenRouter: the
// stream already folded into one JSON object (`model`, `content`,
// `finish_reason`, `usage` with OpenRouter's own `cost` in US dollars, and
// `error`).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { latch } from '../support/lock-wait-race.ts';

export const HAIKU = 'anthropic/claude-haiku-5.5';
export const HAIKU_DATED = 'anthropic/claude-haiku-5.5-20261007';

export interface Received {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

export type Answer = { readonly status: number; readonly body: string } | 'close';

/** A finished answer from `model`, costing `cost` US dollars as OpenRouter reports it. */
export const folded = (model: string, content: string, cost: number | null = 0.000_3): Answer => ({
  status: 200,
  body: JSON.stringify({
    model,
    content,
    finish_reason: 'stop',
    usage: { prompt_tokens: 120, completion_tokens: 12, ...(cost === null ? {} : { cost }) },
    error: null,
  }),
});

export interface OpenRouterStandIn {
  readonly origin: string;
  readonly received: Received[];
  /** What each request gets; a case swaps it. */
  answer: (request: Received) => Answer;
  /** Run when a request arrives, before it is held or answered. */
  onReceipt: ((request: Received) => Promise<void>) | undefined;
  /** Holds every request after it is recorded, until `open`. */
  shut(): void;
  open(): void;
  /** Resolves once `n` requests in all have arrived. */
  arrived(n: number): Promise<void>;
  close(): Promise<void>;
}

function answerWith(response: ServerResponse, answer: Answer): void {
  if (answer === 'close') {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
    response.write('{"model":"anthropic/claude-haiku-5.5","content":"Two');
    setTimeout(() => response.socket?.destroy(), 20);
    return;
  }
  response.statusCode = answer.status;
  response.setHeader('content-type', 'application/json');
  response.end(answer.body);
}

// oxlint-disable-next-line max-lines-per-function -- the stand-in and its controls
export async function standInOpenRouter(): Promise<OpenRouterStandIn> {
  const received: Received[] = [];
  let gate = latch();
  gate.open();
  const standIn: OpenRouterStandIn = {
    origin: '',
    received,
    answer: (request) => folded(String(request.body['model']), 'Two tasks are due today.'),
    onReceipt: undefined,
    shut: () => {
      gate = latch();
    },
    open: () => gate.open(),
    arrived: async (n) => {
      for (let tries = 0; tries < 1_000 && received.length < n; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polls the recorded requests
        await sleep(10);
      }
      if (received.length < n) throw new Error(`${String(n)} requests never reached OpenRouter`);
    },
    close: async () => await Promise.resolve(),
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      const seen: Received = {
        path: request.url ?? '',
        method: request.method ?? '',
        authorization: request.headers.authorization,
        raw,
        body: JSON.parse(raw) as Record<string, unknown>,
      };
      received.push(seen);
      const answering = async (): Promise<void> => {
        await standIn.onReceipt?.(seen);
        await gate.promise;
        answerWith(response, standIn.answer(seen));
      };
      void answering().catch(() => response.socket?.destroy());
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
