// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { admitConversations, hearsConversation } from '../../packages/core-commands/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { createGroupWorld } from './c71-g-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

function latch() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a chat grant expiring before the live membership statement refuses the thread and board',
  // eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
  async () => {
    const g = await createGroupWorld('sol357expiry');
    const { world } = g.chat.harness;
    if (world.mia.personId === null) throw new Error('fixture has no person');
    const reader = connect(world.db.appUrl, { max: 2 });
    const reached = latch();
    const resume = latch();
    let waiting = 0;
    const paused: Database = {
      log: reader.log,
      close: () => reader.close(),
      withBusiness: (business, run) =>
        reader.withBusiness(business, (tx) =>
          run({
            ...tx,
            async query<Row>(
              statement: string,
              parameters?: readonly unknown[],
            ): Promise<readonly Row[]> {
              if (statement.includes('select m.conversation_id::text as id')) {
                waiting += 1;
                if (waiting === 2) reached.release();
                await resume.promise;
              }
              return await tx.query<Row>(statement, parameters);
            },
          }),
        ),
    };
    let admissions: Promise<unknown[]> | undefined;
    try {
      await world.db.admin.execute(
        `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
        where business_id = $1 and subject_id = $2
          and collection = 'chat' and action = 'comment' and revoked_at is null`,
        [world.alpha, world.mia.personId],
      );
      admissions = Promise.all([
        admitConversations(paused, world.alpha, world.mia.presented, [g.conversationId], 'recheck'),
        hearsConversation(paused, world.alpha, world.mia.presented, world.mia.personId, [
          g.conversationId,
        ]),
      ]);
      await reached.promise;
      await world.db.admin.execute('select pg_sleep(2.1)');
      expect(
        await hearsConversation(
          world.db.app,
          world.alpha,
          world.mia.presented,
          world.mia.personId,
          [g.conversationId],
        ),
      ).toBe(false);
      resume.release();
      const [thread, board] = await admissions;
      expect.soft(thread).not.toEqual([g.conversationId]);
      expect.soft(board).toBe(false);
    } finally {
      resume.release();
      await admissions;
      await reader.close();
      await g.chat.harness.close();
    }
  },
  180_000,
);
