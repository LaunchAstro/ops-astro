// SPDX-License-Identifier: AGPL-3.0-only
//
// The carriage (`carriage.ts`) over Supabase Realtime's private broadcast
// channels, for the hosted function: one socket per joined topic, opened with
// the login's own access token, which is the only identity the project's
// policies on `realtime.messages` see (`ops_carry_may_join`). A message is
// sent with `ack: true`, which says only that Realtime has it. The function
// never hears its own messages (`self: false`). A join that cannot be made
// within its window is refused, never waited on.

import { RealtimeClient } from '@supabase/realtime-js';
import type { Carriage, Line } from './carriage.ts';

export interface RealtimeCarriageOptions {
  /** The project's Realtime address, `wss://<project>.supabase.co/realtime/v1`. */
  readonly url: string;
  /** The project's publishable key: an address, not a credential. */
  readonly apiKey: string;
  readonly joinTimeoutMs?: number;
}

const JOIN_TIMEOUT_MS = 5_000;

export function realtimeCarriage(options: RealtimeCarriageOptions): Carriage {
  const timeout = options.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
  return {
    join: async (topic, accessToken) => {
      const client = new RealtimeClient(options.url, {
        params: { apikey: options.apiKey },
        accessToken: async () => await Promise.resolve(accessToken),
        timeout,
      });
      const listeners = new Set<(event: string, message: unknown) => void>();
      const channel = client.channel(topic, {
        config: { private: true, broadcast: { ack: true, self: false } },
      });
      channel.on('broadcast', { event: '*' }, (message: { event: string; payload: unknown }) => {
        for (const listener of listeners) listener(message.event, message.payload);
      });
      const close = async (): Promise<void> => {
        await client.removeAllChannels().catch(() => []);
        await client.disconnect().catch(() => 'timeout');
      };
      const joined = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeout);
        channel.subscribe((status) => {
          clearTimeout(timer);
          resolve(status === 'SUBSCRIBED');
        }, timeout);
      });
      if (!joined) {
        await close();
        return { ok: false, code: 'CARRIAGE_UNAVAILABLE' };
      }
      const line: Line = {
        send: async (event, message) => {
          const sent = await channel
            .send({ type: 'broadcast', event, payload: message })
            .catch(() => 'error');
          return sent === 'ok' ? 'sent' : 'failed';
        },
        hear: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        leave: close,
      };
      return { ok: true, line };
    },
  };
}
