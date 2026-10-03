// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.42, an @mention in a team conversation, over the real HTTP routes: it
// lands in the inbox (MP-7-3) by the path a task comment's mention takes, a
// mention of someone outside the conversation is refused as a task mention of
// someone who cannot read is, and nothing is emailed beyond the existing
// batched mention rule. The cast is `c71-g-world.ts`'s: Tess's group holds Ada
// and Mia, and Zed is alpha staff outside it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import type { Caller } from '../acceptance/cast.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createGroupWorld, detailOf, type GroupWorld } from './c71-g-world.ts';

// eslint-disable-next-line max-lines-per-function -- one world, the ticket's lines
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71 chat mentions', () => {
  let g: GroupWorld;

  const inboxOf = async (who: Caller): Promise<readonly InboxEntry[]> =>
    (await g.as(who, 'inbox.read')).body['inbox'] as InboxEntry[];
  const owedOf = async (who: Caller): Promise<number> =>
    Number((await g.as(who, 'inbox.count')).body['owed']);
  const mentionsOf = async (who: Caller, conversationId: string): Promise<readonly InboxEntry[]> =>
    (await inboxOf(who)).filter(
      (entry) => entry.reason === 'mention' && entry.subjectRecordId === conversationId,
    );

  beforeAll(async () => {
    g = await createGroupWorld('c71mention');
  }, 180_000);

  afterAll(async () => {
    await g?.chat.harness.close();
  });

  it('CS-7.42 an @mention in a group conversation lands in the inbox exactly as a task mention does, and nothing is emailed', async () => {
    const { world } = g.chat.harness;
    const owed = await owedOf(world.ada);
    const sent = await g.as(g.chat.tess, 'chat.send_group', {
      conversationId: g.conversationId,
      body: `@Ada a look? ${randomUUID()}`,
      mentions: [world.ada.personId, g.chat.tess.personId],
    });
    expect(sent.status, sent.text).toBe(200);
    const [entry, ...more] = await mentionsOf(world.ada, g.conversationId);
    expect(more).toEqual([]);
    expect(entry).toMatchObject({
      reason: 'mention',
      access: 'readable',
      workState: 'open',
      counted: true,
      factKind: 'record',
      factId: detailOf(sent)['commentId'],
      conversation: { conversationId: g.conversationId, kind: 'group', name: g.groupName },
    });
    expect(entry?.task).toBeUndefined();
    expect(await owedOf(world.ada)).toBe(owed + 1);
    // The author is never told of their own mention.
    expect(await mentionsOf(g.chat.tess, g.conversationId)).toEqual([]);
    // No delivery is attempted on raising: email waits on the batched rule.
    const attempts = await world.db.admin.execute(
      `select 1 from public.inbox_delivery_attempts d
         join public.inbox_items i on i.business_id = d.business_id and i.id = d.item_id
        where i.subject_record_id = $1`,
      [g.conversationId],
    );
    expect(attempts).toEqual([]);
  });

  it('CS-7.42 an @mention in a direct conversation lands in the teammate inbox', async () => {
    const { world } = g.chat.harness;
    const sent = await g.as(world.mia, 'chat.send_direct', {
      teammateId: world.ada.personId,
      body: `@Ada direct ${randomUUID()}`,
      mentions: [world.ada.personId],
    });
    expect(sent.status, sent.text).toBe(200);
    const conversationId = String(detailOf(sent)['conversationId']);
    const [entry] = await mentionsOf(world.ada, conversationId);
    expect(entry).toMatchObject({
      counted: true,
      conversation: { conversationId, kind: 'direct', name: null },
    });
  });

  it('CS-7.42 a mention of someone outside the conversation is refused as a task mention of someone who cannot read is, and nothing is written', async () => {
    const { world } = g.chat.harness;
    const task = await g.chat.harness.freshTask(`mention ${randomUUID()}`);
    const onTask = await g.as(world.ada, 'task.comment', {
      recordId: task.id,
      expectedRevision: task.revision,
      body: 'a task note',
      audience: 'internal',
      mentions: [g.zed.personId],
    });
    const words = `@Zed outside ${randomUUID()}`;
    const inChat = await g.as(g.chat.tess, 'chat.send_group', {
      conversationId: g.conversationId,
      body: words,
      mentions: [g.zed.personId],
    });
    expect(onTask.code).toBe('MENTION_NOT_READABLE');
    expect([inChat.status, inChat.code]).toEqual([onTask.status, onTask.code]);
    expect(await g.bodiesOf(g.chat.tess)).not.toContain(words);
    expect(await mentionsOf(g.zed, g.conversationId)).toEqual([]);
    // Another business's person is refused too, named back as sent.
    const foreign = await g.as(g.chat.tess, 'chat.send_group', {
      conversationId: g.conversationId,
      body: words,
      mentions: [world.bea.personId],
    });
    expect(foreign.code).toBe('MENTION_NOT_READABLE');
  });

  it('CS-7.42 a mention item is held by current members alone: a member removed from the conversation is no longer shown it or counted for it', async () => {
    const { world } = g.chat.harness;
    expect(
      (
        await g.as(g.chat.tess, 'chat.send_group', {
          conversationId: g.conversationId,
          body: `@Mia ${randomUUID()}`,
          mentions: [world.mia.personId],
        })
      ).status,
    ).toBe(200);
    expect(await mentionsOf(world.mia, g.conversationId)).toHaveLength(1);
    const owed = await owedOf(world.mia);
    const removed = await g.as(g.chat.tess, 'chat.change_members', {
      conversationId: g.conversationId,
      remove: [world.mia.personId],
    });
    expect(removed.status, removed.text).toBe(200);
    expect(await mentionsOf(world.mia, g.conversationId)).toEqual([]);
    expect(await owedOf(world.mia)).toBe(owed - 1);
  });

  it('CS-7.42 a re-added member reads from the new join only: a mention raised before they were re-added is not shown or counted (ORCH64-REJOIN)', async () => {
    const { world } = g.chat.harness;
    // Mia was mentioned, then removed (the test above): her item is held from her.
    expect(await mentionsOf(world.mia, g.conversationId)).toEqual([]);
    const owed = await owedOf(world.mia);
    const added = await g.as(g.chat.tess, 'chat.change_members', {
      conversationId: g.conversationId,
      add: [world.mia.personId],
    });
    expect(added.status, added.text).toBe(200);
    expect(await mentionsOf(world.mia, g.conversationId)).toEqual([]);
    expect(await owedOf(world.mia)).toBe(owed);
    // A mention after the re-join is hers, as any member's.
    const after = await g.as(g.chat.tess, 'chat.send_group', {
      conversationId: g.conversationId,
      body: `@Mia again ${randomUUID()}`,
      mentions: [world.mia.personId],
    });
    expect(after.status, after.text).toBe(200);
    expect(await mentionsOf(world.mia, g.conversationId)).toHaveLength(1);
    expect(await owedOf(world.mia)).toBe(owed + 1);
  });
});
