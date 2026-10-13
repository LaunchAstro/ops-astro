// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's reader of a streamed answer: a piece that comes after the
// outcome is never handed on, the outcome is the body, and a stream cut
// before its outcome is no outcome, however its pieces were split.

import { describe, expect, it } from 'vitest';
import { outcomeOf, type Piece } from '../../apps/web/src/operations/streamed.ts';

const streamOf = (parts: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
};

describe('the browser hands on no piece after the outcome', () => {
  it('a piece after the outcome is dropped', async () => {
    const pieces: Piece[] = [];
    const body = await outcomeOf(
      streamOf([
        'event: piece\ndata: Two\nid: 0\n\n',
        'event: outcome\ndata: {"reply":{"answered":true,"body":"Two"}}\n\n',
        'event: piece\ndata: canary-after-outcome\nid: 1\n\n',
      ]),
      (piece) => pieces.push(piece),
    );
    expect(body).toEqual({ reply: { answered: true, body: 'Two' } });
    expect(pieces).toEqual([{ seq: 0, text: 'Two' }]);
  });

  it('an outcome split across reads is read whole; a stream cut before it is none', async () => {
    const split = await outcomeOf(
      streamOf(['event: out', 'come\ndata: {"a"', ':1}\n', '\n']),
      () => {},
    );
    expect(split).toEqual({ a: 1 });
    const cut = await outcomeOf(
      streamOf(['event: piece\ndata: Two\nid: 0\n\n', 'event: outcome\ndata: {"a"']),
      () => {},
    );
    expect(cut).toBeUndefined();
  });
});
