// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { changeGroupMembers, connect } from '../../packages/core-records/src/index.ts';
import { lockConversation } from '../../packages/core-records/src/team/conversations.ts';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import type { Answer } from '../acceptance/world.ts';
import { createGroupWorld, detailOf } from './c71-g-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a send queued before a rejoin delivers its mention when the message is written after the rejoin',
  // eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
  async () => {
    const g = await createGroupWorld('sol357timing');
    const { world } = g.chat.harness;
    const miaId = world.mia.personId;
    if (miaId === null) throw new Error('fixture has no person');
    const writer = connect(world.db.appUrl);
    let sending: Promise<Answer> | undefined;
    try {
      const removed = await g.as(g.chat.tess, 'chat.change_members', {
        conversationId: g.conversationId,
        remove: [world.mia.personId],
      });
      expect(removed.status, removed.text).toBe(200);
      const before = await g.as(world.mia, 'inbox.count');
      await writer.withBusiness(world.alpha, async (tx) => {
        await lockConversation(tx, g.conversationId);
        sending = g.as(g.chat.tess, 'chat.send_group', {
          conversationId: g.conversationId,
          body: 'After Mia rejoins',
          mentions: [world.mia.personId],
        });
        // Observe the real send transaction waiting on the conversation lock.
        await expect
          .poll(
            async () => {
              const rows = await world.db.admin.execute<{ waiting: boolean }>(
                `select exists (select 1 from pg_stat_activity
             where datname = $1 and wait_event_type = 'Lock'
               and query like '%pg_advisory_xact_lock%') as waiting`,
                [world.db.name],
              );
              return rows[0]?.waiting;
            },
            { timeout: 5_000 },
          )
          .toBe(true);
        await changeGroupMembers(tx, g.conversationId, { add: [miaId], remove: [] });
      });
      const sent = await sending;
      if (sent === undefined) throw new Error('send never started');
      expect(sent.status, sent.text).toBe(200);
      const commentId = String(detailOf(sent)['commentId']);
      const [times] = await world.db.admin.execute<{
        readableMessage: boolean;
        itemBeforeJoin: boolean;
      }>(
        `select c.ts_1 >= m.joined_at as "readableMessage", i.raised_at < m.joined_at as "itemBeforeJoin"
         from public.records c
         join public.inbox_items i on i.business_id = c.business_id and i.fact_id = c.id
         join public.team_conversation_members m on m.business_id = i.business_id
          and m.conversation_id = i.subject_record_id and m.person_id = i.recipient_person_id
        where c.id = $1`,
        [commentId],
      );
      expect(times?.readableMessage).toBe(true);
      expect(await g.bodiesOf(world.mia)).toContain('After Mia rejoins');
      const inbox = await g.as(world.mia, 'inbox.read');
      expect
        .soft(inbox.body['inbox'] as readonly InboxEntry[], JSON.stringify(times))
        .toEqual(
          expect.arrayContaining([expect.objectContaining({ factId: commentId, counted: true })]),
        );
      const after = await g.as(world.mia, 'inbox.count');
      expect.soft(after.body['owed']).toBe(Number(before.body['owed']) + 1);
    } finally {
      await sending;
      await writer.close();
      await g.chat.harness.close();
    }
  },
  180_000,
);
