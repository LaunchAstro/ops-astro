// SPDX-License-Identifier: AGPL-3.0-only
//
// `/api/health` reports the live channel as it measures it. The server's own
// wiring (`composeApi`) over the real live topics (`startLiveTopics`) and a
// stand-in listener: while the listener hears the channel, health says
// `listening`; once its connection drops and it has not listened again, health
// says `down` while the runtime database still answers; once it listens again,
// `listening`. It goes red if health reports a flag set at the last connect
// rather than what the listener hears now. No database: the stand-in runtime
// pool hands each notification to the listener while it is connected.

import { describe, expect, it } from 'vitest';
import { keySetUrlFor } from '../../apps/api/auth/supabase.ts';
import { startLiveTopics } from '../../apps/api/live.ts';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import type { AdminConnection, Database, Listener } from '../../packages/core-records/src/index.ts';
import { TEST_ISSUER as ISSUER } from '../support/sign-in.ts';

/** A listener the test can cut off, and the runtime pool that notifies through it. */
function channel() {
  let hear: ((payload: string) => void) | undefined;
  const state = { connected: true };
  const listener = {
    log: { entries: [] },
    listen: async (
      _channel: string,
      onPayload: (payload: string) => void,
      onListening: () => void,
    ) => {
      hear = onPayload;
      onListening();
      await Promise.resolve();
    },
    close: async () => await Promise.resolve(),
  } as unknown as Listener;
  const database = {
    withBusiness: async (_businessId: string, run: (tx: unknown) => Promise<unknown>) =>
      await run({
        query: async (text: string, parameters: readonly unknown[] = []) => {
          if (text.includes('pg_notify') && state.connected) {
            // Delivered at commit, after the statement answers.
            setTimeout(() => hear?.(String(parameters[1])), 5);
          }
          return await Promise.resolve([{ usage: 0 }]);
        },
      }),
    close: async () => await Promise.resolve(),
  } as unknown as Database;
  return { listener, database, state };
}

describe('live health', () => {
  it('reports down while the listener is cut off and the runtime database still answers', async () => {
    const { listener, database, state } = channel();
    const topics = await startLiveTopics(listener);
    const { app } = composeApi({
      database,
      admin: {} as AdminConnection,
      signIn: { issuer: ISSUER, keySetUrl: keySetUrlFor('', ISSUER) ?? '' },
      keys: runtimeKeys({}),
      live: { topics },
    });
    const health = async () =>
      (await (await app.fetch(new Request('http://api.test/api/health'))).json()) as Record<
        string,
        unknown
      >;

    expect(await health()).toMatchObject({ ok: true, live: 'listening' });

    state.connected = false;
    expect(await health()).toMatchObject({ ok: true, database: 'reachable', live: 'down' });

    state.connected = true;
    expect(await health()).toMatchObject({ ok: true, live: 'listening' });
    await topics.close();
  });
});
