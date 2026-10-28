// SPDX-License-Identifier: AGPL-3.0-only
//
// What the model agent shows while a model writes: display words only, sent
// as numbered pieces from 0 at most every PIECE_EVERY_MS, and `working` every
// WORKING_EVERY_MS while no words come (a cold model load). Ollama's are read
// from the whole local stream by its adapter (`ollamaPieces`: whole lines, a
// leading thinking block never shown). OpenRouter's come from custody already
// decoded and redacted (`stream-decode.ts`), and pass as they are. Hermes
// Agent's reply is shown whole when it is done (#2270), so its call shows only
// `working` while it runs.

import {
  HERMES_CONVERSATION,
  ollamaPieces,
  OPENROUTER_CONVERSATION,
  openrouterPieces,
} from '../../packages/core-connectors/src/index.ts';
import { PIECE_EVERY_MS, WORKING_EVERY_MS } from '../../packages/core-custody/src/agent.ts';

/** Pieces of display words for a request to `destination`, at most every PIECE_EVERY_MS, and `working` while none come. */
export function piecesFor(
  destination: string,
  now: () => number,
  say: (event: 'piece' | 'working', body: unknown, seq?: number) => void,
): { push(chunk: string): void; end(): void } {
  const reader =
    destination === HERMES_CONVERSATION.destination
      ? { push: (): readonly string[] => [] }
      : destination === OPENROUTER_CONVERSATION.destination
        ? openrouterPieces()
        : ollamaPieces();
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
