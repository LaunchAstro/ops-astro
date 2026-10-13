// SPDX-License-Identifier: AGPL-3.0-only
//
// The carriage interface (`packages/core-custody/src/carriage.ts`) over the
// test hub (`realtime-hub.ts`), so the carried custody and the agent stand-in
// run on the same join judgement and the same access cache as the hub models.
// A token is read for its `sub` only: the API verified it at the door, and the
// hub's join function is what judges it here.

import type { Carriage, Line } from '../../packages/core-custody/src/index.ts';
import type { Heard, RealtimeHub } from './realtime-hub.ts';

/** The `sub` a JWT names, unverified: the door verified it already. */
export function subOf(token: string): string {
  const [, payload = ''] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub?: unknown;
  };
  return typeof claims.sub === 'string' ? claims.sub : '';
}

/** A Carriage whose lines are hub subscriptions, each heard as the hub delivers to it. */
export function hubCarriage(
  hub: RealtimeHub,
  joined: string[] = [],
  /** Runs before each join is answered: for the function, after its command commits and before the offer. */
  beforeJoin?: { run: (topic: string) => Promise<void> },
): Carriage {
  return {
    join: async (topic, accessToken) => {
      const subscription = await hub.join(topic, { sub: subOf(accessToken) });
      if (subscription === 'refused') return { ok: false, code: 'CARRIAGE_UNAVAILABLE' };
      joined.push(topic);
      await beforeJoin?.run(topic);
      const listeners = new Set<(event: string, message: unknown) => void>();
      const { heard } = subscription;
      // The hub pushes what it delivers onto `heard`; each push is heard as it comes.
      const push = heard.push.bind(heard);
      heard.push = (...items: Heard[]): number => {
        const length = push(...items);
        for (const item of items)
          for (const listener of listeners) listener(item.event, item.payload);
        return length;
      };
      const line: Line = {
        send: async (event, message) =>
          await Promise.resolve(subscription.send(event, message) === 'sent' ? 'sent' : 'failed'),
        hear: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        leave: async () => {
          subscription.leave();
          await Promise.resolve();
        },
      };
      return { ok: true, line };
    },
  };
}
