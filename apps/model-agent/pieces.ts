// SPDX-License-Identifier: AGPL-3.0-only
//
// What the model agent shows while Ollama writes: display words only, read
// from the whole local stream by the Ollama adapter (`ollamaPieces`: whole
// lines, a leading thinking block never shown), sent as numbered pieces from
// 0 at most every PIECE_EVERY_MS, and `working` every WORKING_EVERY_MS while
// no words come (a cold model load).

import { ollamaPieces } from '../../packages/core-connectors/src/index.ts';
import { PIECE_EVERY_MS, WORKING_EVERY_MS } from '../../packages/core-custody/src/agent.ts';

/** Pieces of display words, at most every PIECE_EVERY_MS, and `working` while none come. */
export function piecesFor(
  now: () => number,
  say: (event: 'piece' | 'working', body: unknown, seq?: number) => void,
): { push(chunk: string): void; end(): void } {
  const reader = ollamaPieces();
  let waiting = '';
  let seq = 0;
  let said = now();
  const flush = (): void => {
    if (waiting !== '') {
      say('piece', { text: waiting }, seq);
      seq += 1;
      waiting = '';
      said = now();
    } else if (now() - said >= WORKING_EVERY_MS) {
      say('working', {});
      said = now();
    }
  };
  const ticker = setInterval(flush, PIECE_EVERY_MS);
  ticker.unref();
  return {
    push: (chunk: string): void => {
      waiting += reader.push(chunk).join('');
    },
    end: (): void => {
      clearInterval(ticker);
      if (waiting !== '') flush();
    },
  };
}
