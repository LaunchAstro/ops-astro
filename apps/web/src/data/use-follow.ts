// SPDX-License-Identifier: AGPL-3.0-only
//
// `useRead`'s live channel: follow the topic of the read's last answer, or,
// with no topic yet after an unavailable first answer, re-read on the floor
// until one answers.

import { useEffect, useRef } from 'react';
import type { ReadState } from './authorised-read.ts';
import { FLOOR_MS } from './live.ts';
import type { UseReadOptions } from './use-read.ts';

/**
 * Re-read a live read that has no topic yet, its first answer unavailable: on
 * coming online, on being shown, and every 30 s while not hidden (C4), until a
 * re-read answers. The hub can only follow a topic, and the topic comes from an
 * answer.
 */
function untilAnswered(reload: () => void): () => void {
  const retry = (): void => {
    if (document.visibilityState !== 'hidden') reload();
  };
  const floor = setInterval(retry, FLOOR_MS);
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', retry);
  return () => {
    clearInterval(floor);
    window.removeEventListener('online', retry);
    document.removeEventListener('visibilitychange', retry);
  };
}

/**
 * Follow the live topic for what the read shows: the last answer's topic,
 * kept while a re-read is in flight or denied, so a revoked page still hears
 * the channel that tells it so. Each change re-reads as a live one. A read
 * unanswered from an unavailable answer, with no topic of its own yet, re-reads
 * on the floor until one answers (`untilAnswered`); those re-reads are not live.
 */
export function useFollow<T>(
  live: UseReadOptions<T>['live'],
  state: ReadState<T>,
  reread: (live: boolean) => void,
  deps: readonly unknown[],
): void {
  const topicRef = useRef<string | null>(null);
  // Whether that answer is this reader's and this record's: the last one's holds off no recovery.
  const ownRef = useRef(false);
  if (state.outcome === 'ready' || state.outcome === 'empty') {
    topicRef.current = live?.topic(state.value) ?? null;
    ownRef.current = true;
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the grant and the caller's dependency list.
  useEffect(
    () => () => {
      ownRef.current = false;
    },
    deps,
  );
  const topic = topicRef.current;
  const hub = live?.hub;

  // Unanswered from an unavailable answer until a retry answers: a retry that stalls is still
  // loading, and the floor and the listeners stay armed under it.
  const waitingRef = useRef(false);
  if (state.outcome === 'unavailable') waitingRef.current = true;
  else if (state.outcome !== 'loading') waitingRef.current = false;
  const unanswered = hub !== undefined && (topic === null || !ownRef.current) && waitingRef.current;
  useEffect(() => {
    if (unanswered) {
      return untilAnswered(() => {
        reread(false);
      });
    }
    if (hub === undefined || topic === null) return;
    return hub.follow(topic, () => {
      reread(true);
    });
  }, [hub, topic, reread, unanswered]);
}
