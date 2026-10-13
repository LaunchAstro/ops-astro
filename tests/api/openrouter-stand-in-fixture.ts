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

/** A promise opened by hand, kept here so the stand-in reaches no database harness. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  const box: { open?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    box.open = resolve;
  });
  return { promise, open: () => box.open?.() };
}

export const HAIKU = 'anthropic/claude-haiku-5.5';
export const HAIKU_DATED = 'anthropic/claude-haiku-5.5-20261007';

export interface Received {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

/** A server-sent stream: its chunks as written, holding after `holdAfter` of them, cut after the last where `cut` says. */
export interface Streamed {
  readonly status: number;
  readonly chunks: readonly string[];
  readonly holdAfter?: number;
  readonly cut?: boolean;
}

export type Answer = { readonly status: number; readonly body: string } | 'close' | Streamed;

/** One server-sent event carrying `payload` as JSON. */
export const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * OpenRouter's stream for `words`: one content delta each, then the last chunk
 * with the finish and the usage OpenRouter reports (its cost in US dollars), then `[DONE]`.
 */
export function sse(
  model: string,
  words: readonly string[],
  cost: number | null = 0.000_3,
): string[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) =>
    event({
      id: 'gen-1',
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    });
  return [
    ': OPENROUTER PROCESSING\n\n',
    ...words.map((word) => chunk({ role: 'assistant', content: word }, null)),
    chunk({}, 'stop', {
      prompt_tokens: 120,
      completion_tokens: words.length,
      ...(cost === null ? {} : { cost }),
    }),
    'data: [DONE]\n\n',
  ];
}

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
  /** Resolves once a streamed answer has written the chunks before its hold. */
  midway(): Promise<void>;
  /** Lets a streamed answer held midway write the rest. */
  resume(): void;
  /** Resolves once `n` requests in all have arrived. */
  arrived(n: number): Promise<void>;
  close(): Promise<void>;
}

async function streamWith(
  response: ServerResponse,
  answer: Streamed,
  hold: { readonly reached: () => void; readonly resumed: Promise<void> },
): Promise<void> {
  response.writeHead(answer.status, { 'content-type': 'text/event-stream' });
  for (const [at, chunk] of answer.chunks.entries()) {
    if (at === answer.holdAfter) {
      hold.reached();
      // oxlint-disable-next-line no-await-in-loop -- the hold is between two writes
      await hold.resumed;
    }
    response.write(chunk);
  }
  if (answer.cut === true) setTimeout(() => response.socket?.destroy(), 20);
  else response.end();
}

function answerWith(
  response: ServerResponse,
  answer: Answer,
  hold: { readonly reached: () => void; readonly resumed: Promise<void> },
): void {
  if (typeof answer === 'object' && 'chunks' in answer) {
    void streamWith(response, answer, hold);
    return;
  }
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
  let halfway = latch();
  let resumed = latch();
  const standIn: OpenRouterStandIn = {
    origin: '',
    received,
    answer: (request) => folded(String(request.body['model']), 'Two tasks are due today.'),
    onReceipt: undefined,
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
        answerWith(response, standIn.answer(seen), {
          reached: halfway.open,
          resumed: resumed.promise,
        });
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
      resumed.open();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  });
}
