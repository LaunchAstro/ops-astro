// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's count chips at load, each read in the frame's own load and kept
// live on the `board` topic of the tab's one stream (C4), as `/inbox/` is.
//
// MP-7-3: the Notifications tab carries INB-1's owed figure from `inbox.count`.
// C71 (CS-7.42): the Team tab carries the reader's unread from
// `chat.conversations`, the sum of each conversation's own count; the server
// signals the board to a conversation's members when a message is written,
// and the Team screen nudges it after the reader's own read or send.
//
// A figure is the read's, never a tally of rows drawn elsewhere; a refused or
// failed read is no figure, never a zero.

import { useEffect, useState } from 'react';
import type {
  ChatConversationsResult,
  InboxCountResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import type { Session } from '../session/token.ts';
import { BOARD } from './board-live.ts';
import { hubOf } from './live.ts';

type ReadFigure = (client: OperationsClient) => Promise<number | null>;

const owedOf: ReadFigure = async (client) => {
  const answer = await client.read<InboxCountResult>('inbox.count', {});
  return 'value' in answer ? answer.value.owed : null;
};

const unreadOf: ReadFigure = async (client) => {
  const answer = await client.read<ChatConversationsResult>('chat.conversations', {});
  if (!('value' in answer)) return null;
  // A group the reader has left keeps no marker for them, so its unread could never clear.
  const joined = answer.value.conversations.filter((each) => each.members.length > 0);
  return joined.reduce((sum, each) => sum + each.unread, 0);
};

/** Each client's figures being shown, by the read that refreshes them. */
const shownBy = new WeakMap<OperationsClient, Map<() => void, ReadFigure>>();

/** Re-read the Team tab's figure now: the reader moved their own marker or sent. */
export function nudgeTeamUnread(client: OperationsClient): void {
  for (const [read, figure] of shownBy.get(client) ?? []) if (figure === unreadOf) read();
}

function useBoardFigure(
  client: OperationsClient,
  session: Session | null,
  shown: boolean,
  readFigure: ReadFigure,
): number | null {
  const [figure, setFigure] = useState<{ readonly of: Session; readonly n: number } | null>(null);
  useEffect(() => {
    if (session === null || !shown) return;
    let current = true;
    // Only the newest read lands: an older answer never overwrites a newer figure.
    let reads = 0;
    const read = (): void => {
      reads += 1;
      const sequence = reads;
      // An answer the figure cannot take (a malformed body) is no figure.
      void readFigure(client)
        .catch(() => null)
        .then((n) => {
          if (current && reads === sequence) setFigure(n === null ? null : { of: session, n });
          return n;
        });
    };
    read();
    const figures = shownBy.get(client) ?? new Map<() => void, ReadFigure>();
    shownBy.set(client, figures.set(read, readFigure));
    const stop = hubOf(client).follow(BOARD, read);
    return () => {
      current = false;
      figures.delete(read);
      stop();
    };
  }, [client, session, shown, readFigure]);
  return figure !== null && figure.of === session ? figure.n : null;
}

/** The owed figure for this session, or null while unread, refused or failed. */
export const useOwedCount = (
  client: OperationsClient,
  session: Session | null,
  shown: boolean,
): number | null => useBoardFigure(client, session, shown, owedOf);

/** The Team tab's unread for this session, or null while unread, refused or failed. */
export const useTeamUnread = (
  client: OperationsClient,
  session: Session | null,
  shown: boolean,
): number | null => useBoardFigure(client, session, shown, unreadOf);
