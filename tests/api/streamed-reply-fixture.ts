// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's message sent as the side panel sends it when it wants the answer
// as it is written: `Accept: text/event-stream`, through the mounted API. The
// events are read off the response as they arrive, so a case can wait for the
// first piece while the model is still writing, or leave mid-answer.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import type { Member } from '../commands/fixture.ts';
import { authorised, tokenFor } from './fixture.ts';
import { personPath } from './controls-fixture.ts';

export interface StreamEvent {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: string;
}

export interface Streaming {
  readonly status: number;
  readonly contentType: string | null;
  /** The next event, or undefined once the stream has ended. */
  next(): Promise<StreamEvent | undefined>;
  /** Every event until the stream ends. */
  rest(): Promise<StreamEvent[]>;
  /** The browser leaves: the request is aborted and the body cancelled. */
  leave(): Promise<void>;
  /** The body as text, for an answer that is not a stream. */
  text(): Promise<string>;
}

/** Splits an event stream's text into events (`event`, `id`, `data` lines; a blank line ends one). */
function parsed(block: string): StreamEvent | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? undefined : { event, id, data: data.join('\n') };
}

/** `name` sent by `member` with `body` (a fresh operation id unless it names one), asking for a stream. */
// oxlint-disable-next-line max-lines-per-function -- one request and the reader over its stream
export async function sendStreaming(
  api: Hono,
  member: Member,
  name: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Streaming> {
  const aborting = new AbortController();
  const response = await api.fetch(
    new Request(`http://api.test${personPath(name)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...authorised(token ?? (await tokenFor(member.presented.subject))),
      },
      body: JSON.stringify({ operationId: randomUUID(), ...body }),
      signal: aborting.signal,
    }),
  );
  const contentType = response.headers.get('content-type');
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let ended = reader === undefined;
  const next = async (): Promise<StreamEvent | undefined> => {
    for (;;) {
      const split = buffered.indexOf('\n\n');
      if (split !== -1) {
        const block = buffered.slice(0, split);
        buffered = buffered.slice(split + 2);
        const event = parsed(block);
        if (event !== undefined) return event;
        continue;
      }
      if (ended || reader === undefined) return undefined;
      // oxlint-disable-next-line no-await-in-loop -- reads the stream as it arrives
      const read = await reader.read();
      if (read.done) ended = true;
      else buffered += decoder.decode(read.value, { stream: true });
    }
  };
  return {
    status: response.status,
    contentType,
    next,
    rest: async () => {
      const events: StreamEvent[] = [];
      // oxlint-disable-next-line no-await-in-loop -- reads the events as they arrive
      for (let event = await next(); event !== undefined; event = await next()) events.push(event);
      return events;
    },
    leave: async () => {
      aborting.abort();
      await reader?.cancel().catch(() => {});
      ended = true;
    },
    text: async () => {
      let text = buffered;
      for (let read = await reader?.read(); read !== undefined && !read.done;) {
        text += decoder.decode(read.value, { stream: true });
        // oxlint-disable-next-line no-await-in-loop -- reads the body to its end
        read = await reader?.read();
      }
      return text;
    },
  };
}

/**
 * The stream, if its response has begun within `ms` while the model is still
 * holding its answer; undefined when the server waits for the whole answer.
 */
export async function openedWhileWriting(
  sending: Promise<Streaming>,
  ms = 5_000,
): Promise<Streaming | undefined> {
  const stop = new AbortController();
  const late = sleep(ms, 'late' as const, { signal: stop.signal }).catch(() => 'late' as const);
  try {
    const first = await Promise.race([sending, late]);
    return first === 'late' ? undefined : first;
  } finally {
    stop.abort();
  }
}
