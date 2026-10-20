// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's answer shown as it is written: one provisional line in the
// tab, after its question, growing with each piece the stream hands on
// (`operations/streamed.ts`). Pieces come numbered; one missing from the run
// ends the provisional text where the run broke, marked "…", and nothing
// after it is shown. The settled reply, or the words for why there is none,
// replaces the line: it is taken away before either lands.

import type { AssistantMessage } from '@launchastro/ui';
import type { Piece } from '../operations/streamed.ts';
import type { AssistantState } from './chats.ts';
import type { Store } from './store.ts';

/** Where a run broke: the provisional text stops here. */
export const BROKEN = '…';

/** The provisional text so far, the next piece the run expects, and whether it broke. */
export interface Run {
  readonly text: string;
  readonly next: number;
  readonly broken: boolean;
}

export const NOTHING_YET: Run = { text: '', next: 0, broken: false };

/** The run with `piece` added, or stopped at the first piece out of its place. */
export function written(run: Run, piece: Piece): Run {
  if (run.broken) return run;
  if (piece.seq !== run.next) return { ...run, text: `${run.text}${BROKEN}`, broken: true };
  return { text: `${run.text}${piece.text}`, next: run.next + 1, broken: false };
}

/** Line `id` changed by `edit`, or taken out where it answers null. */
function edited(
  state: AssistantState,
  id: string,
  edit: (line: AssistantMessage) => AssistantMessage | null,
): AssistantState {
  return {
    ...state,
    chats: state.chats.map((chat) =>
      chat.messages.some((line) => line.id === id)
        ? {
            ...chat,
            messages: chat.messages.flatMap((line) => {
              if (line.id !== id) return [line];
              const kept = edit(line);
              return kept === null ? [] : [kept];
            }),
          }
        : chat,
    ),
  };
}

/** The pieces for tab `key` as one provisional line on `store`, and its removal once the answer settles. */
export function writer(
  store: Store,
  key: string,
): { readonly onPiece: (piece: Piece) => void; readonly done: () => void } {
  let run = NOTHING_YET;
  let id: string | null = null;
  return {
    onPiece: (piece) => {
      run = written(run, piece);
      id ??= store.line(key, 'ai', '');
      const body = run.text;
      store.update((state) =>
        edited(state, id ?? '', (line) => ({ ...line, body, writing: true })),
      );
    },
    done: () => {
      if (id === null) return;
      const gone = id;
      id = null;
      store.update((state) => edited(state, gone, () => null));
    },
  };
}

/** `send` with its pieces drawn in tab `key` as they come, the provisional line taken away once it answers. */
export async function withPieces<T>(
  store: Store,
  key: string,
  send: (options: { readonly onPiece: (piece: Piece) => void }) => Promise<T>,
): Promise<T> {
  const line = writer(store, key);
  try {
    return await send({ onPiece: line.onPiece });
  } finally {
    line.done();
  }
}
