// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the live task channel's fan-out. One listen-only connection hears every
// business's `business:kind:topic` (migration 0033) and hands each only to
// subscribers filed under that business: the one their session was admitted
// to, never one a caller named. After a reconnect every subscriber resyncs,
// since whatever changed in between was never heard.

import type { Listener } from '../../packages/core-records/src/index.ts';

export const LIVE_CHANNEL = 'ops_astro_live';

export type LiveSignal = 'invalidate' | 'resync';

type Send = (signal: LiveSignal) => void;

export interface LiveTopics {
  /** Hear `taskId` in `businessId`; the returned function stops. */
  subscribe(businessId: string, taskId: string, send: Send): () => void;
  /** Whether LISTEN has been in force since the last (re)connect, for `/api/health`. */
  readonly listening: boolean;
  close(): Promise<void>;
}

export async function startLiveTopics(listener: Listener): Promise<LiveTopics> {
  // `business:task` to its subscribers.
  const subscribers = new Map<string, Set<Send>>();
  let listening = false;

  await listener.listen(
    LIVE_CHANNEL,
    (payload) => {
      const [business, kind, topic, ...rest] = payload.split(':');
      if (kind !== 'task' || rest.length > 0) return;
      for (const send of subscribers.get(`${String(business)}:${String(topic)}`) ?? []) {
        send('invalidate');
      }
    },
    () => {
      if (listening)
        for (const sends of subscribers.values()) for (const send of sends) send('resync');
      listening = true;
    },
  );

  return {
    subscribe(businessId, taskId, send) {
      const key = `${businessId}:${taskId}`;
      const sends = subscribers.get(key) ?? new Set<Send>();
      subscribers.set(key, sends.add(send));
      return () => {
        sends.delete(send);
        if (sends.size === 0 && subscribers.get(key) === sends) subscribers.delete(key);
      };
    },
    get listening() {
      return listening;
    },
    async close() {
      listening = false;
      await listener.close();
    },
  };
}
