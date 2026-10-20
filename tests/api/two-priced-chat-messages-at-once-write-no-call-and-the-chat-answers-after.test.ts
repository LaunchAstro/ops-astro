// SPDX-License-Identifier: AGPL-3.0-only
//
// #1508, option B, raced: on the install whose conversation operation is
// priced (the replay stand-in), two of a person's messages in one conversation
// reach the conversation seam at the same instant, each on a connection of its
// own. The seam refuses both before it writes or locks anything: while a
// holder keeps `public.model_calls` in share mode (so any row written there
// would wait) and holds the seam's limit lock, both answer BUDGET_UNAVAILABLE
// at once, and nothing ever waits on the holder. No call row, no provider
// request, both person messages kept, no reply. The conversation stays usable:
// an unpriced model asked afterwards answers the second message, at nothing.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { CONVERSATION_ANSWER } from '../../packages/core-connectors/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, isWaitedOn } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import { pricedReplayInstall, type PricedInstall } from './priced-replay-install-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Rejects after `ms`, so a refusal that waited on the holder fails instead of hanging. */
const within = async <T>(ms: number, work: Promise<T>): Promise<T> =>
  await Promise.race([
    work,
    sleep(ms).then(() => {
      throw new Error(`still waiting after ${String(ms)} ms`);
    }),
  ]);

// eslint-disable-next-line max-lines-per-function -- two installs, one world and their checks
describe.skipIf(serverUrl === undefined)('two priced chat messages at the same instant', () => {
  let priced: PricedInstall;
  let unpriced: LocalModel;
  let w: ConversationWorld;

  beforeAll(async () => {
    priced = await pricedReplayInstall();
    unpriced = await localModel();
    // The API keeps the person's messages and answers nothing; the case calls each exchange itself.
    const fixture = await createApiFixture('priced_chat_race');
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
  }, 180_000);

  afterAll(async () => {
    await priced?.stop();
    await unpriced?.close();
    await w?.drop();
  });

  const roles = async (conversationId: string): Promise<readonly string[]> =>
    (
      await w.fixture.db.admin.execute<{ readonly role: string }>(
        `select role from public.conversation_messages
          where conversation_id = $1 order by created_at, id`,
        [conversationId],
      )
    ).map((row) => row.role);

  const callsOn = async (conversationId: string) =>
    await w.fixture.db.admin.execute<{
      readonly state: string;
      readonly reserved: number;
      readonly actual: number | null;
    }>(
      `select state, reserved_minor::int as reserved, actual_minor::int as actual
         from public.model_calls where conversation_id = $1`,
      [conversationId],
    );

  // eslint-disable-next-line max-lines-per-function -- one schedule, its checks and its clean-up
  it('refuses both before any row or lock, keeps both messages, and an unpriced model answers after', async () => {
    const { db, business } = w.fixture;
    const opened = detail(
      await w.as(w.owner, 'conversation.start', { body: 'What is due today?' }),
    );
    const conversationId = String(opened['conversationId']);
    const first = { conversationId, messageId: String(opened['messageId']) };
    const added = detail(
      await w.as(w.owner, 'conversation.message', { conversationId, body: 'And this week?' }),
    );
    const second = { conversationId, messageId: String(added['messageId']) };
    expect(await roles(conversationId)).toStrictEqual(['person', 'person']);

    const sentBefore = priced.provider.seen.length;
    // Any call row written, and the seam's limit lock, would wait on this holder.
    const limit = `limit:${business}:model_call:${CONVERSATION_ANSWER.key}`;
    const holder = await hold(db, async (execute) => {
      await execute('lock table public.model_calls in share mode');
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [limit]);
    });
    const readers = [0, 1].map(() => connect(db.appUrl, { source: 'runtime' }));
    const asking: Promise<ConversationReply | null>[] = [];
    try {
      asking.push(
        priced.exchange(readers[0]!, business, w.owner.presented, first),
        priced.exchange(readers[1]!, business, w.owner.presented, second),
      );
      const replies = await within(10_000, Promise.all(asking));
      for (const reply of replies) {
        expect(reply).toMatchObject({ answered: false, code: 'BUDGET_UNAVAILABLE' });
      }
      expect(await isWaitedOn(db, holder)).toBe(false);
    } finally {
      await holder.letGo();
      await Promise.allSettled(asking);
      await Promise.allSettled(readers.map(async (one) => await one.close()));
    }

    expect(priced.provider.seen.length - sentBefore).toBe(0);
    expect(await callsOn(conversationId)).toHaveLength(0);
    expect(await roles(conversationId)).toStrictEqual(['person', 'person']);

    // Asked of an unpriced model afterwards, the second message is answered, at nothing.
    const unpricedBefore = unpriced.provider.seen.length;
    const later = await within(
      10_000,
      unpriced.exchange(db.app, business, w.owner.presented, second),
    );
    expect(later).toMatchObject({ answered: true });
    expect(unpriced.provider.seen.length - unpricedBefore).toBe(1);
    expect(await callsOn(conversationId)).toEqual([{ state: 'settled', reserved: 0, actual: 0 }]);
    expect(await roles(conversationId)).toStrictEqual(['person', 'person', 'agent']);
  }, 60_000);
});
