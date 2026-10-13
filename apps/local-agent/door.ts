// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's door (LA-1): what a request to its one route is,
// whether it carries the runner's key, and how a reply goes out. A whole
// answer is one JSON body. A call that asks to stream (GPT streamed) is
// answered as NDJSON: a `piece` line as each piece comes, then one `answer`
// line holding the body a whole answer has. Pieces are provisional; the
// answer is what counts.

import { createHash, timingSafeEqual } from 'node:crypto';
import { LOCAL_GPT_BODY_LIMIT } from '../../packages/core-connectors/src/index.ts';
import { DEFAULT_MODEL } from './gate.ts';

/** A model name the runner passes on: no spaces, no flags, nothing to split. */
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const MAX_BODY_BYTES = LOCAL_GPT_BODY_LIMIT;

export interface CallRequest {
  readonly model: string;
  readonly fields: Readonly<Record<string, string>>;
  /** The caller takes the answer as NDJSON pieces, then the answer (codex-app.ts). */
  readonly stream: boolean;
  /**
   * The send deadline custody passes on (`x-ops-send-by`, Unix ms): the turn
   * never starts after it, and the call is never queued. None on the laptop.
   */
  readonly sendBy: number | null;
}

/** A send deadline as custody writes it: whole milliseconds, nothing else. */
const SEND_BY = /^\d{1,15}$/u;

/** The request's send deadline: null when it carries none, undefined when it is malformed. */
function sendByOf(request: DoorRequest): number | null | undefined {
  const value = request.headers['x-ops-send-by'];
  if (value === undefined) return null;
  return typeof value === 'string' && SEND_BY.test(value) ? Number(value) : undefined;
}

/**
 * What the door reads of a request: its headers and its body's chunks. The
 * runner's server (runner.ts) hands it Node's own request, which is one.
 */
export interface DoorRequest extends AsyncIterable<unknown> {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the door writes of a reply; Node's own response is one. */
export interface DoorResponse {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Readonly<Record<string, string>>): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

export function authorised(request: DoorRequest, key: string): boolean {
  const sent = request.headers['authorization'];
  // Node gives one authorization header as a string; anything else carries no key.
  const header = typeof sent === 'string' ? sent : '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return timingSafeEqual(digest(presented), digest(key));
}

/** The request body, or why not: too large, or not the one shape the route takes. */
export async function readCall(request: DoorRequest): Promise<CallRequest | 400 | 413> {
  const sendBy = sendByOf(request);
  if (sendBy === undefined) return 400;
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += (part as Buffer).length;
    if (bytes > MAX_BODY_BYTES) return 413;
    parts.push(part as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return 400;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 400;
  const shape = parsed as Record<string, unknown>;
  const model = shape['model'] ?? DEFAULT_MODEL;
  const fields = shape['fields'];
  const stream = shape['stream'] ?? false;
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) return 400;
  if (typeof stream !== 'boolean') return 400;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return 400;
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, value]) => typeof value === 'string')) {
    return 400;
  }
  return { model, fields: fields as Record<string, string>, stream, sendBy };
}

export function send(response: DoorResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/**
 * A streamed call's reply: `sent` once its turn is started, each piece a line
 * as it comes, then the answer's line, the body a whole answer has. Pieces are
 * provisional; the answer is what counts.
 */
export function streamed(response: DoorResponse): {
  readonly sent: () => void;
  readonly piece: (text: string) => void;
  readonly answer: (body: unknown) => void;
} {
  const open = (): void => {
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  };
  return {
    sent: () => {
      open();
      response.write(line({ sent: true }));
    },
    piece: (text) => {
      open();
      response.write(line({ piece: text }));
    },
    answer: (body) => {
      open();
      response.end(line({ answer: body }));
    },
  };
}
