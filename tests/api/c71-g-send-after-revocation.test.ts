// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executeCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { lockConversation } from '../../packages/core-records/src/team/conversations.ts';
import type { Answer } from '../acceptance/world.ts';
import { createGroupWorld } from './c71-g-world.ts';

// eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
it('Sol proof, criterion 5: a queued chat send cannot write a message or mention after sender chat authority is revoked', async () => {
  const g = await createGroupWorld('sol357sender');
  const { world } = g.chat.harness;
  const writer = connect(world.db.appUrl);
  const revoker = connect(world.db.appUrl);
  const words = 'Message and mention after sender authority ended';
  let sending: Promise<Answer> | undefined;
  try {
    await writer.withBusiness(world.alpha, async (tx) => {
      await lockConversation(tx, g.conversationId);
      sending = g.as(world.mia, 'chat.send_group', {
        conversationId: g.conversationId,
        body: words,
      });
      await expect
        .poll(
          async () => {
            const [waiting] = await world.db.admin.execute<{ waiting: boolean }>(
              `select exists (select 1 from pg_stat_activity
            where datname = $1 and wait_event_type = 'Lock'
              and query like '%pg_advisory_xact_lock%') as waiting`,
              [world.db.name],
            );
            return waiting?.waiting;
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      const [grant] = await world.db.admin.execute<{ id: string }>(
        `select id from public.grants where business_id = $1 and subject_id = $2
          and collection = 'chat' and action = 'comment' and revoked_at is null`,
        [world.alpha, world.mia.personId],
      );
      expect(grant).toBeDefined();
      const revoked = await executeCommand(revoker, world.alpha, world.ada.presented, 'api', {
        command: 'access.revoke',
        operationId: randomUUID(),
        grantId: String(grant?.id),
      });
      expect(revoked).not.toHaveProperty('refused');
      expect(
        await executeRead(revoker, world.alpha, world.mia.presented, {
          read: 'chat.messages',
          conversationId: g.conversationId,
        }),
      ).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    });
    const sent = await sending;
    expect.soft(sent?.code, sent?.text).toBe('SCOPE_NOT_GRANTED');
    expect.soft(await g.bodiesOf(world.ada)).not.toContain(words);
    const written = await world.db.admin.execute(
      `select i.id from public.inbox_items i join public.records c
        on c.business_id = i.business_id and c.id = i.fact_id
       where i.business_id = $1 and c.data ->> 'body' = $2`,
      [world.alpha, words],
    );
    expect(written).toEqual([]);
  } finally {
    await sending;
    await writer.close();
    await revoker.close();
    await g.chat.harness.close();
  }
}, 180_000);
