// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's client asks for a person's message to be answered as an
// event stream only when its caller takes pieces. It hands each piece on in
// the order it came, with its number, and returns the `outcome` event's body
// exactly as the JSON answer would be returned. A refusal still comes back as
// JSON and is returned as one. A stream that ends with no outcome is the
// answer not finishing: unavailable, in those words, never a success.

import { describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

const OUTCOME = { recordId: 'm-1', revision: 1, detail: { conversationId: 'c-1' } };

interface Heard {
  readonly accept: string | null;
}

/** A client over a fetch that answers `respond()` and notes what each request asked for. */
function clientOver(respond: () => Response): { client: OperationsClient; heard: Heard[] } {
  const heard: Heard[] = [];
  const fetch = ((_url: string, init?: RequestInit) => {
    heard.push({ accept: new Headers(init?.headers).get('accept') });
    return Promise.resolve(respond());
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
  });
  return { client, heard };
}

const stream = (text: string): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Cut in odd places, as a network cuts it.
        const bytes = new TextEncoder().encode(text);
        for (let at = 0; at < bytes.length; at += 5) controller.enqueue(bytes.slice(at, at + 5));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const event = (name: string, data: string, id?: number): string =>
  `event: ${name}\n${id === undefined ? '' : `id: ${String(id)}\n`}${data
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`;

// oxlint-disable-next-line max-lines-per-function -- one client, four answers
describe('the operations client reads a streamed answer', () => {
  it('asks for a stream only when the caller takes pieces', async () => {
    const { client, heard } = clientOver(() => Response.json(OUTCOME));
    await client.mutate('conversation.message', { conversationId: 'c-1', body: 'Hi' });
    await client.mutate(
      'conversation.message',
      { conversationId: 'c-1', body: 'Hi' },
      { onPiece: () => {} },
    );
    expect(heard.map((each) => each.accept)).toStrictEqual([null, 'text/event-stream']);
  });

  it('hands each piece on in order with its number, then returns the outcome as JSON would be', async () => {
    const text =
      event('piece', 'Two ', 0) +
      event('piece', 'tasks\nare', 1) +
      event('piece', ' due.', 2) +
      event('outcome', JSON.stringify(OUTCOME));
    const { client } = clientOver(() => stream(text));
    const pieces: { seq: number; text: string }[] = [];
    const result = await client.mutate(
      'conversation.message',
      { conversationId: 'c-1', body: 'Hi' },
      { onPiece: (piece) => pieces.push(piece) },
    );
    expect(pieces).toStrictEqual([
      { seq: 0, text: 'Two ' },
      { seq: 1, text: 'tasks\nare' },
      { seq: 2, text: ' due.' },
    ]);
    expect(result).toStrictEqual({ ok: true, value: OUTCOME });
  });

  it('returns a refusal answered in JSON as a refusal', async () => {
    const refusal = { refused: true, code: 'NOT_FOUND', message: 'No such conversation.' };
    const { client } = clientOver(() => Response.json(refusal, { status: 404 }));
    const result = await client.mutate(
      'conversation.message',
      { conversationId: 'c-1', body: 'Hi' },
      { onPiece: () => {} },
    );
    expect(result).toStrictEqual(refusal);
  });

  it('a stream that ends with no outcome is an answer that did not finish', async () => {
    const { client } = clientOver(() => stream(event('piece', 'Two ', 0)));
    const result = await client.mutate(
      'conversation.message',
      { conversationId: 'c-1', body: 'Hi' },
      { onPiece: () => {} },
    );
    expect(result).toMatchObject({ unavailable: true });
    expect(JSON.stringify(result)).toContain('did not finish');
  });
});
