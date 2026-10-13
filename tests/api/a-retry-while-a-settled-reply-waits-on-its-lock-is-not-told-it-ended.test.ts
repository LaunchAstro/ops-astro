// SPDX-License-Identifier: AGPL-3.0-only
//
// A retry of a message whose settled reply is still waiting on the
// conversation's lock, past 30 seconds, is never told the answer ended: the
// reply lands, and the retry says so or waits for it.

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { createApiFixture } from './fixture.ts';
import { conversationWorld, detail } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { ollamaBroker, standInOllama } from './ollama-stand-in-fixture.ts';
import { hold } from '../support/lock-wait-race.ts';
import { waitingOn } from '../support/lock-waits.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a reply blocked for more than 30 seconds is not reported as ended',
  // oxlint-disable-next-line max-lines-per-function -- two brokers, one stand-in and one held row
  async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const ollama = await standInOllama();
    const first = await ollamaBroker(ollama.origin);
    const second = await ollamaBroker(ollama.origin);
    const fixture = await createApiFixture('slow_reply_keep');
    const world = await conversationWorld({
      fixture,
      api: composedWith(fixture, () => Promise.resolve(null)),
    });
    const reader = connect(fixture.db.appUrl, { source: 'runtime' });
    const started = detail(
      await world.as(world.owner, 'conversation.start', { body: 'Due today?' }),
    );
    const asked = {
      conversationId: String(started['conversationId']),
      messageId: String(started['messageId']),
    };
    const row = await hold(fixture.db, async (execute) => {
      await execute('select 1 from public.conversations where id = $1 for no key update', [
        asked.conversationId,
      ]);
    });
    let pending: ReturnType<typeof first.exchange> | undefined;
    let retry: ReturnType<typeof second.exchange> | undefined;
    try {
      pending = first.exchange(reader, fixture.business, world.owner.presented, asked);
      await waitingOn(
        fixture.db.admin,
        'transactionid',
        'select body_purged_at from conversations',
      );
      // Use real elapsed time. Neither the call's timestamps nor the product clock are edited.
      await delay(31_100);
      const [settled] = await fixture.db.admin.execute<{ state: string; old: boolean }>(
        `select state, ended_at < clock_timestamp() - interval '30 seconds' as old
         from public.model_calls where conversation_id = $1`,
        [asked.conversationId],
      );
      expect(settled).toEqual({ state: 'settled', old: true });
      retry = second.exchange(fixture.db.app, fixture.business, world.owner.presented, asked);
      // A retry that asks again or returns at once ends the wait; so do 5 s. Release the lock
      // after whichever comes first, then prove the reply lands.
      await Promise.race([retry, ollama.arrived(2), delay(5_000)]);
      await row.letGo();
      expect(await pending).toMatchObject({ answered: true });
      const retried = await retry;
      expect(
        retried,
        'The original reply landed, but the retry told the person to send again',
      ).not.toMatchObject({ code: 'ANSWER_ENDED' });
    } finally {
      await row.letGo();
      await Promise.allSettled([pending, retry]);
      await reader.close();
      await first.stop();
      await second.stop();
      await ollama.close();
      await world.drop();
      vi.unstubAllEnvs();
    }
  },
  120_000,
);
