// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 on the page: who else is on this task, read from the presence book
// through the tab's own seat. The seat comes with the tab's one stream
// (`live.ts`); each `presence` on the topic, and each new seat, re-reads
// `live/presence`, and only the latest answer is drawn. A mark says which
// field this tab is changing; marks go out one after another, so the last one
// sent is the one the book keeps, and a new seat is told the field still being
// changed. Advisory throughout: nothing else waits on any of it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperationsClient } from '../operations/client.ts';
import { hubOf } from './live.ts';

/** One other person on a task, as `live/presence` answers. */
export interface PresenceView {
  readonly personId: string;
  readonly name: string;
  readonly state: 'viewing' | 'changing';
  readonly field: string | null;
}

export interface Presence {
  readonly seen: readonly PresenceView[];
  /** The field this tab is changing, or null when it stops. */
  mark(field: string | null): void;
}

const NOBODY: readonly PresenceView[] = [];

/** Who else is on `topic` from `seat`, or null when refused or unreachable. */
async function readPresence(
  client: OperationsClient,
  seat: string,
  topic: string,
): Promise<readonly PresenceView[] | null> {
  const query = `seat=${encodeURIComponent(seat)}&topic=${encodeURIComponent(topic)}`;
  const answer = await client.live(`presence?${query}`, {});
  const seenBy = (answer as { seenBy?: unknown } | null)?.seenBy;
  return Array.isArray(seenBy) ? (seenBy as PresenceView[]) : null;
}

/** Mark the field `seat` is changing, or null; an unanswered or refused mark changes nothing else. */
async function markPresence(
  client: OperationsClient,
  seat: string,
  topic: string,
  field: string | null,
): Promise<void> {
  await client.live('mark', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seat, topic, field }),
  });
}

/** This tab's seat on the topic and the field it is changing, kept across renders. */
interface Held {
  seat: string | null;
  field: string | null;
}

/** Who else is on `topic` through each seat the hub hands; a new seat is told the field held. */
function useSeen(
  client: OperationsClient,
  topic: string | null,
  held: Held,
  send: (seat: string, topic: string, field: string | null) => void,
): readonly PresenceView[] {
  const [seen, setSeen] = useState<readonly PresenceView[]>(NOBODY);
  useEffect(() => {
    if (topic === null) return;
    let asked = 0;
    let open = true;
    const answer = async (seat: string, ask: number): Promise<void> => {
      const seenBy = await readPresence(client, seat, topic);
      if (open && ask === asked) setSeen(seenBy ?? NOBODY);
    };
    const stop = hubOf(client).presence(topic, (seat) => {
      const renewed = seat !== held.seat;
      held.seat = seat;
      asked += 1;
      if (seat === null) setSeen(NOBODY);
      else {
        if (renewed && held.field !== null) send(seat, topic, held.field);
        void answer(seat, asked);
      }
    });
    return () => {
      open = false;
      stop();
      held.seat = null;
      setSeen(NOBODY);
    };
  }, [client, topic, held, send]);
  return seen;
}

export function usePresence(client: OperationsClient, topic: string | null): Presence {
  const held = useRef<Held>({ seat: null, field: null }).current;
  const sent = useRef<Promise<void>>(Promise.resolve());

  const send = useCallback(
    (at: string, where: string, marked: string | null) => {
      sent.current = sent.current.then(async () => await markPresence(client, at, where, marked));
    },
    [client],
  );
  const seen = useSeen(client, topic, held, send);

  const mark = useCallback(
    (next: string | null) => {
      if (held.field === next) return;
      held.field = next;
      if (held.seat !== null && topic !== null) send(held.seat, topic, next);
    },
    [held, topic, send],
  );

  return { seen, mark };
}
