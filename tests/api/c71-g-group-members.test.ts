// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G, who is in a group conversation and from when, over the real HTTP
// routes: each test is named after its ticket line. A member added later reads
// from the moment they joined; a removed or departed member reads nothing
// written after; a re-added member reads from the new join only. Any member
// leaves, their own membership alone. The cast is `c71-g-world.ts`'s.

// oxlint-disable no-await-in-loop -- one caller at a time, each read back
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createGroupWorld, detailOf, type GroupWorld } from './c71-g-world.ts';

// eslint-disable-next-line max-lines-per-function -- one world, the ticket's lines
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-G group members', () => {
  let g: GroupWorld;

  beforeAll(async () => {
    g = await createGroupWorld('c71gm');
  }, 180_000);

  afterAll(async () => {
    await g?.chat.harness.close();
  });

  it('a member added later reads from the moment they joined; a removed member reads nothing written after removal; a re-added member reads from the new join only', async () => {
    const { chat, zed, conversationId, as, say, viewOf, bodiesOf, auditOf } = g;
    const { world } = chat.harness;
    const { mia, ada } = world;
    const before = await bodiesOf(mia);
    const added = await as(chat.tess, 'chat.change_members', {
      conversationId,
      add: [zed.personId],
    });
    expect(added.status, added.text).toBe(200);
    expect(await bodiesOf(zed)).toEqual([]);
    expect((await viewOf(zed))?.unread).toBe(0);
    expect((await say(ada, 'after zed joined')).status).toBe(200);
    expect(await bodiesOf(zed)).toEqual(['after zed joined']);
    expect((await viewOf(zed))?.unread).toBe(1);
    // An administrator removes Mia; what she could read stays, nothing after.
    const removed = await as(ada, 'chat.change_members', {
      conversationId,
      remove: [mia.personId],
    });
    expect(removed.status, removed.text).toBe(200);
    expect((await say(zed, 'after mia left')).status).toBe(200);
    expect(await bodiesOf(mia)).toEqual([...before, 'after zed joined']);
    expect((await viewOf(mia))?.unread).toBe(2);
    expect((await viewOf(mia))?.members).toEqual([]);
    expect((await say(mia, 'still here?')).code).toBe('NOT_FOUND');
    expect((await viewOf(ada))?.members).not.toContain(mia.personId);
    // Re-added: from the new join only, the old history too.
    expect(
      (await as(chat.tess, 'chat.change_members', { conversationId, add: [mia.personId] })).status,
    ).toBe(200);
    expect(await bodiesOf(mia)).toEqual([]);
    expect((await say(ada, 'welcome back')).status).toBe(200);
    expect(await bodiesOf(mia)).toEqual(['welcome back']);
    // Someone not in it is not there to remove; adding a member, removing
    // oneself (a member leaves) and naming nobody change nothing.
    for (const [body, code] of [
      [{ remove: [randomUUID()] }, 'NOT_FOUND'],
      [{ add: [ada.personId] }, 'FIELD_VALUE_INVALID'],
      [{ remove: [chat.tess.personId] }, 'FIELD_VALUE_INVALID'],
      [{}, 'FIELD_VALUE_INVALID'],
    ] as const) {
      const answer = await as(chat.tess, 'chat.change_members', { conversationId, ...body });
      expect(answer.code, JSON.stringify(body)).toBe(code);
    }
    expect((await auditOf('chat.change_members', ada.actorId)).map((e) => e.outcome)).toEqual([
      'applied',
    ]);
  });

  it('any member may leave: their own membership only, and they read nothing written after it', async () => {
    const { chat, zed, conversationId, as, say, viewOf, bodiesOf, auditOf } = g;
    const { world } = chat.harness;
    const left = await as(zed, 'chat.leave', { conversationId });
    expect(left.status, left.text).toBe(200);
    const kept = await bodiesOf(zed);
    expect((await say(world.ada, 'after zed left')).status).toBe(200);
    expect(await bodiesOf(zed)).toEqual(kept);
    expect((await as(zed, 'chat.leave', { conversationId })).code).toBe('NOT_FOUND');
    expect(
      (await as(zed, 'chat.mark_read', { conversationId, upTo: new Date().toISOString() })).code,
    ).toBe('NOT_FOUND');
    expect((await viewOf(world.ada))?.members).not.toContain(zed.personId);
    expect((await auditOf('chat.leave', zed.actorId)).map((e) => e.outcome)).toEqual([
      'applied',
      'refused',
    ]);
    // A direct conversation is not a group: there is nothing to leave.
    const direct = await chat.send(world.ada, world.mia, 'direct');
    const directId = String(detailOf(direct)['conversationId']);
    expect((await as(world.mia, 'chat.leave', { conversationId: directId })).code).toBe(
      'NOT_FOUND',
    );
    expect((await say(world.mia, 'into a direct', directId)).code).toBe('NOT_FOUND');
  });

  it('the command that causes each tracked action writes it in the same transaction, and appends it to the audit chain with no message body', async () => {
    const { chat, canary, conversationId, as, say, auditOf } = g;
    const renamed = await as(chat.tess, 'chat.rename_group', { conversationId, name: 'Renamed' });
    expect(renamed.status, renamed.text).toBe(200);
    for (const command of [
      'chat.start_group',
      'chat.send_group',
      'chat.rename_group',
      'chat.change_members',
      'chat.leave',
    ]) {
      const events = await auditOf(command);
      expect(
        events.map((e) => e.outcome),
        command,
      ).toContain('applied');
      for (const event of events) expect(event.t, command).not.toContain(canary);
    }
    // A refused send writes nothing and is audited refused.
    const sends = (await auditOf('chat.send_group')).length;
    expect((await say(chat.harness.world.ada, '   ')).code).toBe('FIELD_VALUE_INVALID');
    expect((await auditOf('chat.send_group')).slice(sends).map((e) => e.outcome)).toEqual([
      'refused',
    ]);
  });
});
