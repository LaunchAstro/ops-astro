// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the live task channel's fan-out.
//
// One listen-only connection per process hears every business's
// invalidations (`migrations/0033_live_task_channel.sql`). Each payload is
// `business:kind:topic`, and it reaches only the subscribers filed under the
// business it names. A subscriber is filed under the business its session was
// admitted to, never one a caller named, so a forged topic under another
// business hears nothing. What arrives says only that a task changed; the page
// re-reads through the ordinary checked read.
//
// When the connection drops, postgres.js reconnects and listens again, and
// every subscriber is told to resync: whatever changed in between was never
// heard.

import type { Listener } from '../../packages/core-records/src/index.ts';

export const LIVE_CHANNEL = 'ops_astro_live';

export type LiveSignal = 'invalidate' | 'resync';

type Send = (signal: LiveSignal) => void;

export interface LiveTopics {
  /** Hear `taskId` in `businessId`; the returned function stops. */
  subscribe(businessId: string, taskId: string, send: Send): () => void;
  /** Whether LISTEN is in force right now, for `/api/health`. */
  readonly listening: boolean;
  close(): Promise<void>;
}

export async function startLiveTopics(listener: Listener): Promise<LiveTopics> {
  const byBusiness = new Map<string, Map<string, Set<Send>>>();
  let listening = false;
  let listenedBefore = false;

  const everyone = function* (): Generator<Send> {
    for (const topics of byBusiness.values()) for (const sends of topics.values()) yield* sends;
  };

  await listener.listen(
    LIVE_CHANNEL,
    (payload) => {
      const [business, kind, topic, ...rest] = payload.split(':');
      if (business === undefined || topic === undefined || kind !== 'task' || rest.length > 0) {
        return;
      }
      for (const send of byBusiness.get(business)?.get(topic) ?? []) send('invalidate');
    },
    () => {
      listening = true;
      if (listenedBefore) for (const send of everyone()) send('resync');
      listenedBefore = true;
    },
  );

  return {
    subscribe(businessId, taskId, send) {
      const topics = byBusiness.get(businessId) ?? new Map<string, Set<Send>>();
      byBusiness.set(businessId, topics);
      const sends = topics.get(taskId) ?? new Set<Send>();
      topics.set(taskId, sends);
      sends.add(send);
      return () => {
        sends.delete(send);
        if (sends.size === 0) topics.delete(taskId);
        if (topics.size === 0) byBusiness.delete(businessId);
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
