// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.42, team chat's live delivery over the existing sync (C4), against a
// real database and a real LISTEN connection: a message stamps and notifies
// its conversation's topic; a tab follows `conversation:<id>` on its one
// stream, admitted for a current member alone; and the board stream tells a
// conversation's current members, and nobody else, that it moved. No second
// transport. The cast is `c71-g-world.ts`'s: Tess's group holds Ada and Mia,
// Zed is alpha staff outside it, and Bea and Bo talk in bravo.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { count, sleep, within, type Joined } from './c4-live-support.ts';
import { conversationTopic, createLiveGroupWorld, type LiveGroupWorld } from './c71-live-world.ts';

const BOARD = 'board';

/** The status and every byte of a refused join: two refusals that differ in nothing. */
const refusalOf = (joined: Joined): string => `${String(joined.status)} ${joined.raw}`;

/** The board runs its digest before it asks of a conversation: slower than a task topic. */
const BOARD_MS = 10_000;

// eslint-disable-next-line max-lines-per-function -- one world, the ticket's lines
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71 live conversations', () => {
  let w: LiveGroupWorld;

  beforeAll(async () => {
    w = await createLiveGroupWorld('c71live');
  }, 180_000);

  afterAll(async () => {
    await w?.close();
  });

  it('CS-7.42 a message written in a conversation stamps its conversation topic in the live change record and notifies it on the live channel', async () => {
    const { g, payloads } = w;
    const { world } = g.chat.harness;
    expect((await g.say(g.chat.tess, `stamped ${randomUUID()}`)).status).toBe(200);
    const payload = `${world.alpha}:conversation:${g.conversationId}`;
    await within(3_000, () => payloads.includes(payload), 'the conversation topic notified');
    const stamped = await world.db.admin.execute<{ readonly kind: string }>(
      `select subject_kind as kind from public.live_changes
        where business_id = $1 and subject_id = $2`,
      [world.alpha, g.conversationId],
    );
    expect(stamped.map((row) => row.kind)).toEqual(['conversation']);
    // Never a task topic: the message names no task.
    expect(payloads.filter((one) => one.endsWith(g.conversationId))).not.toContain(
      `${world.alpha}:task:${g.conversationId}`,
    );
  });

  it('CS-7.42 a new message shows in the open thread: a member following conversation:<id> on the tab stream hears it without a refresh', async () => {
    const { g } = w;
    const topic = conversationTopic(g.conversationId);
    const tab = await w.open(g.chat.tess, [topic]);
    expect(tab.status, JSON.stringify(tab.refusal)).toBe(200);
    await within(3_000, () => count(tab, 'resync', topic) === 1, 'the thread resynced at join');
    expect((await g.say(g.chat.harness.world.ada, `live ${randomUUID()}`)).status).toBe(200);
    await within(3_000, () => count(tab, 'invalidate', topic) >= 1, 'the thread heard it');
  });

  it('CS-7.42 isolation: a conversation topic is refused to another person, another business and a member who has left exactly as a fabricated id is', async () => {
    const { g } = w;
    const { world } = g.chat.harness;
    const real = conversationTopic(g.conversationId);
    const fabricated = conversationTopic(randomUUID());
    const crossings: readonly [string, { readonly token: string }, string][] = [
      ['another person', g.zed, 'alpha'],
      ['another business', world.bea, 'bravo'],
    ];
    for (const [label, caller, key] of crossings) {
      // eslint-disable-next-line no-await-in-loop
      const foreign = await w.open(caller, [real], key);
      // eslint-disable-next-line no-await-in-loop
      const made = await w.open(caller, [fabricated], key);
      expect(foreign.status, label).toBe(404);
      expect(refusalOf(foreign), label).toBe(refusalOf(made));
    }
    // Mia follows the thread, then leaves: her stream is closed, and a new join
    // is refused as a fabricated id is.
    const mia = await w.open(world.mia, [real]);
    await within(3_000, () => count(mia, 'resync', real) === 1, 'Mia joined');
    expect((await g.as(world.mia, 'chat.leave', { conversationId: g.conversationId })).status).toBe(
      200,
    );
    await within(
      3_000,
      () => count(mia, 'closed', real) === 1,
      'the stream of a member who left closed',
    );
    const left = await w.open(world.mia, [real]);
    expect(left.status).toBe(404);
    expect(refusalOf(left)).toBe(refusalOf(await w.open(world.mia, [fabricated])));
  });

  it("CS-7.42 the Team tab's unread chip moves over the board stream: a conversation's change is said to its current members and to nobody else", async () => {
    const { g } = w;
    const { world } = g.chat.harness;
    const tess = await w.open(g.chat.tess, [BOARD]);
    const zed = await w.open(g.zed, [BOARD]);
    const bea = await w.open(world.bea, [BOARD], 'bravo');
    for (const tab of [tess, zed, bea]) {
      expect(tab.status, JSON.stringify(tab.refusal)).toBe(200);
    }
    await within(
      BOARD_MS,
      () => [tess, zed, bea].every((t) => count(t, 'resync', BOARD) >= 1),
      'joined',
    );
    expect((await g.say(world.ada, `chip ${randomUUID()}`)).status).toBe(200);
    await within(BOARD_MS, () => count(tess, 'conversation', BOARD) === 1, 'a member was told');
    // Each stream's signals are handled in order: a later conversation of their
    // own told to Zed and to Bea proves the group's message was handled for them
    // first, and said nothing.
    expect((await g.chat.send(world.ada, g.zed, `to zed ${randomUUID()}`)).status).toBe(200);
    expect(
      (await g.chat.send(g.chat.bo, world.bea, `to bea ${randomUUID()}`, 'bravo')).status,
    ).toBe(200);
    await within(BOARD_MS, () => count(zed, 'conversation', BOARD) === 1, 'Zed told of his own');
    await within(BOARD_MS, () => count(bea, 'conversation', BOARD) === 1, 'Bea told of her own');
    await sleep(500);
    expect(count(zed, 'conversation', BOARD)).toBe(1);
    expect(count(bea, 'conversation', BOARD)).toBe(1);
    expect(count(tess, 'conversation', BOARD)).toBe(1);
    // A frame names no conversation: the tab re-reads through its own reads.
    for (const tab of [tess, zed, bea]) {
      for (const { data } of tab.heard) expect(data).toBe(BOARD);
    }
  });
});
