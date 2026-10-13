// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await, max-lines-per-function -- a reviewer's proof, its body kept as written */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startConversationSweeper } from '../../apps/api/conversation-sweeper.ts';
import { shutDown, shutdownStages } from '../../apps/api/server.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { sweeperWorld, type SweeperWorld } from '../api/r7-sweeper-fixture.ts';

it('the sweep finishes before server shutdown closes its database', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const events: string[] = [];
  const database = {
    close: async () => {
      events.push('database closed');
    },
  } as unknown as Database;
  const sweeper = startConversationSweeper(database, {
    businesses: async () => ['business-one'],
    codeRevision: '26022e1',
    sweep: async () => {
      events.push('sweep started');
      entered();
      await gate;
      events.push('sweep ended');
      return { wrapped: [], purged: [], held: [], failed: [], windowUnreadable: false };
    },
  });
  await started;
  const stopped = shutDown(
    ...shutdownStages({
      topics: undefined,
      mail: undefined,
      conversations: sweeper.stop,
      database: database.close,
      admin: undefined,
      broker: undefined,
      sweeper: undefined,
      tracer: undefined,
    }),
  );
  try {
    await Promise.resolve();
    expect(events).toEqual(['sweep started']);
  } finally {
    resume();
    await stopped;
  }
  expect(events).toEqual(['sweep started', 'sweep ended', 'database closed']);
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'stopping a running conversation sweep',
  () => {
    let s: SweeperWorld;

    beforeAll(async () => {
      s = await sweeperWorld('sol1370_sweep');
      await s.window(s.alpha, 7);
    }, 180_000);

    afterAll(async () => {
      await s?.w.drop();
    });

    it('stopping a sweep finishes the current conversation and starts no next conversation', async () => {
      const first = await s.dueInAlpha('first due conversation');
      const second = await s.dueInAlpha('second due conversation');
      let reached!: () => void;
      const currentFinished = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let transactions = 0;
      const paused: Database = {
        ...s.db,
        withBusiness: async (business, run) => {
          const result = await s.db.withBusiness(business, run);
          transactions += 1;
          if (transactions === 2) {
            reached();
            await gate;
          }
          return result;
        },
      };
      const sweeper = startConversationSweeper(paused, {
        businesses: async () => [s.alpha],
        codeRevision: '26022e1',
      });
      try {
        await currentFinished;
        const stopping = sweeper.stop();
        resume();
        await stopping;
      } finally {
        resume();
        await sweeper.stop();
      }
      expect(await s.wrapUps(first)).toBe(1);
      expect(
        await s.wrapUps(second),
        'the next conversation must wait for a future running sweeper',
      ).toBe(0);
    });
  },
);
