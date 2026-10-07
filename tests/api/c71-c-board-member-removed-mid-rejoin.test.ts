// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { followBoard } from '../../apps/api/live-board.ts';
import type { LiveStream } from '../../apps/api/live-follow.ts';
import { startLiveTopics } from '../../apps/api/live.ts';
import {
  boardReach,
  hearsConversation,
  joinLiveBoard,
  shownInbox,
} from '../../packages/core-commands/src/index.ts';
import { connectListener } from '../../packages/core-records/src/index.ts';
import { createGroupWorld } from './c71-g-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'removing a member while the board rejoin is in flight prevents the pending conversation frame',
  // eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
  async () => {
    const g = await createGroupWorld('sol357boardrace');
    const { world } = g.chat.harness;
    const topics = await startLiveTopics(connectListener(world.db.appUrl));
    const writes: { event: string | undefined; data: string }[] = [];
    const stops: (() => void | Promise<void>)[] = [];
    let aborted = false;
    const stream: LiveStream = {
      get aborted() {
        return aborted;
      },
      onAbort: (callback) => {
        stops.push(callback);
      },
      abort() {
        aborted = true;
        for (const stop of stops) void stop();
      },
      async writeSSE(frame) {
        writes.push({ event: frame.event, data: await frame.data });
      },
    };
    let release: (() => void) | undefined;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let joins = 0;
    let rejoining = false;
    let heard = 0;
    const caller = world.mia;
    if (caller.personId === null) throw new Error('fixture has no person');
    const running = followBoard(
      stream,
      topics,
      {
        businessId: world.alpha,
        personId: caller.personId,
        recheckMs: 100_000,
      },
      {
        async joinedAs() {
          joins += 1;
          if (joins === 2) {
            rejoining = true;
            await pause;
          }
          const answer = await joinLiveBoard(world.db.app, world.alpha, caller.presented);
          return 'personId' in answer ? answer.personId : undefined;
        },
        reach: async (person) =>
          await boardReach(world.db.app, world.alpha, caller.presented, person),
        shown: async (person) =>
          await shownInbox(world.db.app, world.alpha, caller.presented, person),
        async hears(person, chats) {
          const member = await hearsConversation(
            world.db.app,
            world.alpha,
            caller.presented,
            person,
            chats,
          );
          heard += 1;
          return member;
        },
      },
    );
    try {
      await expect.poll(() => writes.some((frame) => frame.event === 'resync')).toBe(true);
      expect((await g.say(g.chat.tess, 'Message before Mia is removed')).status).toBe(200);
      await expect.poll(() => rejoining).toBe(true);
      expect(heard).toBe(1);
      const removed = await g.as(g.chat.tess, 'chat.change_members', {
        conversationId: g.conversationId,
        remove: [caller.personId],
      });
      expect(removed.status, removed.text).toBe(200);
      expect(
        await hearsConversation(world.db.app, world.alpha, caller.presented, caller.personId, [
          g.conversationId,
        ]),
      ).toBe(false);
      release?.();
      await expect.poll(() => heard).toBeGreaterThanOrEqual(2);
      expect(writes.filter((frame) => frame.event === 'conversation')).toEqual([]);
    } finally {
      release?.();
      stream.abort();
      await running;
      await topics.close();
      await g.chat.harness.close();
    }
  },
  180_000,
);
