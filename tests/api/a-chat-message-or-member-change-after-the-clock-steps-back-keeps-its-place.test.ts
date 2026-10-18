// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop, max-lines-per-function -- Sol's proofs, kept as written; the outsiders are checked one after another */
//
// #935 m2: a conversation keeps its own forward-only clock. A message written
// after the wall clock steps back still sits after the reader's marker, and a
// member change cut on that clock still separates what each member reads.
// Each case controls only the clock source of its own writes, through the real
// writers, by swapping `clock_timestamp()` for an earlier time. The first three
// cases are Sol's proofs from #1806's review and the fourth from #1812's, bodies as written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGroupWorld, detailOf, type GroupWorld } from './c71-g-world.ts';
import { enrolCaller } from '../acceptance/cast.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  changeGroupMembers,
  lockConversation,
  moveReadMarker,
  readPositionOf,
  readConversationTypes,
  writeComment,
} from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { ChatMessageView } from '../../packages/core-wire/src/index.ts';

/** The same transaction with its wall clock read as `at`. */
const clockAt = (tx: TenantQuery, at: string): TenantQuery => ({
  ...tx,
  query: (sql, params) =>
    tx.query(sql.replaceAll('clock_timestamp()', `'${at}'::timestamptz`), params),
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a conversation clock that never steps back',
  () => {
    let g: GroupWorld;
    beforeAll(async () => {
      g = await createGroupWorld('clockback');
    }, 180_000);
    afterAll(async () => {
      await g?.chat.harness.close();
    });

    /** A fresh group Tess starts with Ada and Mia, its first message from Ada, and that message's time. */
    async function groupWithOneMessage(name: string): Promise<{ id: string; at: string }> {
      const { world } = g.chat.harness;
      const started = await g.start(g.chat.tess, [world.ada.personId, world.mia.personId], name);
      expect(started.status, started.text).toBe(200);
      const id = String(detailOf(started)['conversationId']);
      expect((await g.say(world.ada, `${name} before`, id)).status).toBe(200);
      const read = await g.as(world.ada, 'chat.messages', { conversationId: id });
      return { id, at: (read.body['messages'] as ChatMessageView[])[0]!.at };
    }

    /** Run `write` under the conversation's lock with the wall clock a second before `at`. */
    async function aSecondBefore(
      at: string,
      id: string,
      write: (tx: TenantQuery) => Promise<void>,
    ) {
      const { world } = g.chat.harness;
      const backwards = new Date(Date.parse(at) - 1000).toISOString();
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        await lockConversation(tx, id);
        await write(clockAt(tx, backwards));
      });
    }

    it('a member holding the management grant who did not start the group may manage it, and an ordinary member may not', async () => {
      const { world } = g.chat.harness;
      const manager = await enrolCaller(world.db, world.alpha, 'alpha', 'sol-manager', {
        membership: true,
        actions: ['comment', 'manage'],
        collections: ['chat'],
      });
      expect(
        (
          await g.as(g.chat.tess, 'chat.change_members', {
            conversationId: g.conversationId,
            add: [manager.personId],
          })
        ).status,
      ).toBe(200);
      expect((await g.viewOf(manager))?.canManage).toBe(true);
      expect((await g.viewOf(world.mia))?.canManage).toBe(false);
      expect((await g.viewOf(g.chat.tess))?.canManage).toBe(true);
      expect((await g.viewOf(world.ada))?.canManage).toBe(true);
    });

    it('another business’s person, a client and a non-member of the same business neither read a group nor rename it', async () => {
      const { world, clients } = g.chat.harness;
      const client = clients.find((c) => c.businessKey === 'alpha');
      if (client === undefined) throw new Error('client fixture absent');
      for (const outsider of [world.bea, g.zed, client]) {
        const read = await g.as(outsider, 'chat.messages', { conversationId: g.conversationId });
        expect(read.body['refused']).toBe(true);
        expect(read.text).not.toContain(g.canary);
        const write = await g.as(outsider, 'chat.rename_group', {
          conversationId: g.conversationId,
          name: 'forged',
        });
        expect(write.body['refused']).toBe(true);
      }
    });

    it('a message written after the clock steps back stays unread after the reader’s marker', async () => {
      const { world } = g.chat.harness;
      const started = await g.chat.send(world.mia, g.chat.tess, 'seen before clock step');
      expect(started.status).toBe(200);
      const id = String((started.body['detail'] as Record<string, unknown>)['conversationId']);
      const read = await g.as(g.chat.tess, 'chat.messages', { conversationId: id });
      const at = (read.body['messages'] as ChatMessageView[])[0]!.at;
      expect(
        (await g.as(g.chat.tess, 'chat.mark_read', { conversationId: id, upTo: at })).status,
      ).toBe(200);
      expect((await g.viewOf(g.chat.tess, id))?.unread).toBe(0);
      // Keep the simulated clock regression within both people's membership window.
      await world.db.admin.execute(
        "update public.team_conversation_members set joined_at = joined_at - interval '1 day' where business_id=$1 and conversation_id=$2",
        [world.alpha, id],
      );
      const backwards = new Date(Date.parse(at) - 1000).toISOString();
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        await lockConversation(tx, id);
        const types = await readConversationTypes(tx);
        if (types === undefined) throw new Error('types absent');
        // The real writer, with only the wall-clock source controlled for this one write.
        await writeComment(
          {
            ...tx,
            query: (sql, params) =>
              tx.query(sql.replaceAll('clock_timestamp()', `'${backwards}'::timestamptz`), params),
          },
          types.commentTypeId,
          {
            taskId: null,
            conversationId: id,
            authorActorId: world.mia.actorId!,
            commentType: 'note',
            audience: 'direct',
            body: 'unseen after backward clock step',
            source: 'api',
          },
        );
      });
      expect(await g.bodiesOf(g.chat.tess, id)).toContain('unseen after backward clock step');
      expect(
        (await g.viewOf(g.chat.tess, id))?.unread,
        'a later write must not hide behind the existing marker',
      ).toBe(1);
    });

    it('a message written after the clock steps back stays unread past another member’s later marker', async () => {
      const { world } = g.chat.harness;
      const id = g.conversationId;
      const read = await g.as(world.mia, 'chat.messages', { conversationId: id });
      const at = (read.body['messages'] as ChatMessageView[])[0]!.at;
      const markerTime = new Date(Date.parse(at) + 1000).toISOString();
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        await lockConversation(tx, id);
        // A normal send advances its sender's marker to now, after the message insert.
        expect(await moveReadMarker(clockAt(tx, markerTime), id, world.mia.personId!, 'now')).toBe(
          true,
        );
      });
      expect((await g.viewOf(world.mia))?.unread).toBe(0);
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        await lockConversation(tx, id);
        const types = await readConversationTypes(tx);
        if (!types) throw new Error('missing types');
        await writeComment(clockAt(tx, at), types.commentTypeId, {
          taskId: null,
          conversationId: id,
          authorActorId: world.ada.actorId!,
          commentType: 'note',
          audience: 'group',
          body: 'unseen after later marker',
          source: 'api',
        });
      });
      expect(await g.bodiesOf(world.mia)).toContain('unseen after later marker');
      expect(
        (await g.viewOf(world.mia))?.unread,
        'later message must not hide behind the marker',
      ).toBe(1);
    });

    it('a marker moved while the clock is stepped back counts the messages stamped past that clock', async () => {
      const { world } = g.chat.harness;
      const { id, at } = await groupWithOneMessage('marked late');
      await aSecondBefore(at, id, async (tx) => {
        const types = await readConversationTypes(tx);
        if (types === undefined) throw new Error('types absent');
        await writeComment(tx, types.commentTypeId, {
          taskId: null,
          conversationId: id,
          authorActorId: world.ada.actorId!,
          commentType: 'note',
          audience: 'group',
          body: 'marked late after',
          source: 'api',
        });
      });
      const read = await g.as(g.chat.tess, 'chat.messages', { conversationId: id });
      const shown = (read.body['messages'] as ChatMessageView[]).map((m) => m.at);
      expect(shown).toHaveLength(2);
      expect((await g.viewOf(g.chat.tess, id))?.unread).toBe(2);
      // Tess saw both; her marker moves to the last while the clock still reads a second behind them.
      await aSecondBefore(at, id, async (tx) => {
        const upTo = readPositionOf(shown.at(-1));
        if (upTo === undefined) throw new Error('the last message has no read position');
        expect(await moveReadMarker(tx, id, g.chat.tess.personId!, upTo)).toBe(true);
      });
      expect((await g.viewOf(g.chat.tess, id))?.unread).toBe(0);
    });

    it('a member added after the clock steps back reads nothing written before they joined', async () => {
      const { id, at } = await groupWithOneMessage('added late');
      await aSecondBefore(at, id, async (tx) => {
        await changeGroupMembers(tx, id, { add: [g.zed.personId!], remove: [] });
      });
      expect(await g.bodiesOf(g.zed, id)).toEqual([]);
      expect((await g.say(g.chat.harness.world.ada, 'after zed joined', id)).status).toBe(200);
      expect(await g.bodiesOf(g.zed, id)).toEqual(['after zed joined']);
    });

    it('a member removed after the clock steps back keeps what came before and reads nothing written after', async () => {
      const { world } = g.chat.harness;
      const { id, at } = await groupWithOneMessage('removed late');
      await aSecondBefore(at, id, async (tx) => {
        await changeGroupMembers(tx, id, { add: [], remove: [world.mia.personId!] });
        const types = await readConversationTypes(tx);
        if (types === undefined) throw new Error('types absent');
        await writeComment(tx, types.commentTypeId, {
          taskId: null,
          conversationId: id,
          authorActorId: world.ada.actorId!,
          commentType: 'note',
          audience: 'group',
          body: 'after mia left',
          source: 'api',
        });
      });
      expect(await g.bodiesOf(world.mia, id)).toEqual(['removed late before']);
      expect(await g.bodiesOf(world.ada, id)).toEqual(['removed late before', 'after mia left']);
    });
  },
);
