// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- a reviewer's proof, its body kept as written */
import { expect, it } from 'vitest';
import { startLiveTopics, PROBE_MS } from '../../apps/api/live.ts';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import type { AdminConnection, Database, Listener } from '../../packages/core-records/src/index.ts';
import { ISSUER } from './fixture.ts';
import { keySetUrlFor } from '../../apps/api/auth/supabase.ts';

it('the health probe deadline also bounds a stalled notification transaction', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listener = {
    listen: async (_channel: string, _hear: unknown, listening: () => void) => {
      listening();
    },
    close: async () => {},
  } as unknown as Listener;
  const topics = await startLiveTopics(listener);
  const database = {
    withBusiness: async (_businessId: string, run: (tx: unknown) => Promise<unknown>) =>
      await run({
        query: async (text: string) => {
          if (text.includes('pg_notify')) await held;
          return [{ usage: 0 }];
        },
      }),
  } as unknown as Database;
  const { app } = composeApi({
    database,
    admin: {} as AdminConnection,
    signIn: { issuer: ISSUER, keySetUrl: keySetUrlFor('', ISSUER) ?? '' },
    keys: runtimeKeys({}),
    live: { topics },
  });
  const response = app.fetch(new Request('http://api.test/api/health'));
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      response,
      new Promise<'held'>((resolve) => {
        timer = setTimeout(() => resolve('held'), PROBE_MS + 300);
      }),
    ]);
    expect(answer, 'health remained held after the listener probe deadline').not.toBe('held');
    if (answer instanceof Response)
      expect(await answer.json()).toMatchObject({ database: 'reachable', live: 'down' });
  } finally {
    clearTimeout(timer);
    release();
    await response;
    await topics.close();
  }
});
