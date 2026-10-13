// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's message answered as an event stream (`apps/api/agent-answers.ts`):
// a `piece` event for each display text of the answer as the model writes
// it, numbered in its `id`, then one `outcome` event whose data is the JSON
// body the same request answers without a stream. The pieces are provisional;
// only the outcome counts. A stream that ends with no outcome is an answer
// that did not finish.

/** One piece of the answer as it is written, and its place in the run. */
export interface Piece {
  readonly seq: number;
  readonly text: string;
}

export const UNFINISHED = 'The answer did not finish.';

/** Whether the API answered with an event stream rather than JSON. */
export const isEventStream = (response: Response): boolean =>
  (response.headers.get('content-type') ?? '').startsWith('text/event-stream');

interface StreamEvent {
  readonly name: string;
  readonly id: string | undefined;
  readonly data: string;
}

/** One event's lines (`event`, `id`, `data`), the data lines joined as the stream split them. */
function eventOf(block: string): StreamEvent {
  let name = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');
    if (field === 'event') name = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  return { name, id, data: data.join('\n') };
}

/** The outcome's body, parsed, after each piece is handed on; undefined when none came. */
export async function outcomeOf(
  body: ReadableStream<Uint8Array> | null,
  onPiece: (piece: Piece) => void,
): Promise<unknown> {
  if (body === null) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after the other
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffered += decoder.decode(read.value, { stream: true });
      for (let split = buffered.indexOf('\n\n'); split !== -1; split = buffered.indexOf('\n\n')) {
        const event = eventOf(buffered.slice(0, split));
        buffered = buffered.slice(split + 2);
        if (event.name === 'outcome') return JSON.parse(event.data) as unknown;
        if (event.name === 'piece') onPiece({ seq: Number(event.id), text: event.data });
      }
    }
  } catch {
    // A stream cut off, or an outcome that is not JSON: no outcome came.
  }
  return undefined;
}
