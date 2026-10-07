// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { createGroupWorld, detailOf } from './c71-g-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

function latch() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a seen stamp under way when the recipient is removed from the conversation writes no attention',
  // eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
  async () => {
    const g = await createGroupWorld('c71seenremove');
    const { world } = g.chat.harness;
    const reader = connect(world.db.appUrl);
    const reached = latch();
    const resume = latch();
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
              if (statement.includes('insert into public.inbox_attention')) {
                reached.release();
                await resume.promise;
              }
              return await tx.query<Row>(statement, parameters);
            },
          }),
        ),
    };
    let stamping: ReturnType<typeof executeCommand> | undefined;
    try {
      const sent = await g.as(g.chat.tess, 'chat.send_group', {
        conversationId: g.conversationId,
        body: '@Mia before removal',
        mentions: [world.mia.personId],
      });
      expect(sent.status, sent.text).toBe(200);
      const [item] = await world.db.admin.execute<{ id: string }>(
        'select id from public.inbox_items where business_id = $1 and fact_id = $2 and recipient_person_id = $3',
        [world.alpha, detailOf(sent)['commentId'], world.mia.personId],
      );
      if (item === undefined) throw new Error('mention item missing');
      stamping = executeCommand(paused, world.alpha, world.mia.presented, 'api', {
        command: 'inbox.seen',
        operationId: randomUUID(),
        itemId: item.id,
      });
      await reached.promise;
      const removed = await g.as(g.chat.tess, 'chat.change_members', {
        conversationId: g.conversationId,
        remove: [world.mia.personId],
      });
      expect(removed.status, removed.text).toBe(200);
      expect((await g.as(world.mia, 'inbox.seen', { itemId: item.id })).code).toBe('NOT_FOUND');
      resume.release();
      expect.soft(await stamping).toMatchObject({ refused: true, code: 'NOT_FOUND' });
      expect
        .soft(
          await world.db.admin.execute(
            'select 1 from public.inbox_attention where business_id = $1 and item_id = $2',
            [world.alpha, item.id],
          ),
        )
        .toEqual([]);
    } finally {
      resume.release();
      await stamping;
      await reader.close();
      await g.chat.harness.close();
    }
  },
  180_000,
);
