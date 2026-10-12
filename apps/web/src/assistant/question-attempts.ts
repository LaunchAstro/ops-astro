// SPDX-License-Identifier: AGPL-3.0-only
//
// One attempt per question the person sends. Its operation id is minted as
// the question is asked, before anything waits, and each send of it carries
// that id and the payload its first send carried, frozen. A lost answer leaves
// the attempt waiting, its question drawn with Send again, and only Send again
// sends it once more, so the register replays a start or message it kept, and
// its reply, with no second model call. Typing the same words is a new
// question. The attempt settles once, on its first known answer, and that
// answer is the one its caller draws. The attempts are the drawer's alone: a
// drawer remounted for another business or person has none of them.

import { useState } from 'react';
import type { CommandOutcome, OperationsClient } from '../operations/client.ts';
import { settle, type Settlement } from '../records/use-command.ts';

export type QuestionCommand = 'conversation.start' | 'conversation.message';

/** A question whose answer was lost: Send again, disabled while its resend is out. */
export interface LostQuestion {
  readonly id: string;
  /** The tab it was asked in, and its question line. */
  readonly key: string;
  readonly line: string;
  readonly resending: boolean;
  readonly again: () => void;
}

/** Sends the question's command once, then again on each Send again, until an answer is known. */
export type Attempt = (
  command: QuestionCommand,
  payload: Readonly<Record<string, unknown>>,
) => Promise<Settlement<CommandOutcome>>;

export function useQuestionAttempts(client: OperationsClient): {
  readonly lost: readonly LostQuestion[];
  readonly begin: (key: string, line: string) => Attempt;
} {
  const [lost, setLost] = useState<readonly LostQuestion[]>([]);
  const begin = (key: string, line: string): Attempt => {
    // Minted as the client mints one (operations/client.ts), and held here for every send.
    const operationId = crypto.randomUUID();
    const drawn = (entry: LostQuestion | null): void => {
      setLost((list) => {
        const rest = list.filter((each) => each.id !== operationId);
        if (entry === null) return rest;
        return rest.length === list.length
          ? [...list, entry]
          : list.map((each) => (each.id === operationId ? entry : each));
      });
    };
    return async (command, payload) => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a resend goes only after its Send again
        const settled = settle(await client.mutate(command, payload, { operationId }));
        if (settled.kind !== 'unknown') {
          drawn(null);
          return settled;
        }
        // eslint-disable-next-line no-await-in-loop -- waits for the person's Send again
        await new Promise<void>((resend) => {
          const entry = { id: operationId, key, line };
          const again = (): void => {
            drawn({ ...entry, resending: true, again: () => {} });
            resend();
          };
          drawn({ ...entry, resending: false, again });
        });
      }
    };
  };
  return { lost, begin };
}
