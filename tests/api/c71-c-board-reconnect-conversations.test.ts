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
import { connectListener, type Listener } from '../../packages/core-records/src/index.ts';
import { createGroupWorld } from './c71-g-world.ts';

// eslint-disable-next-line max-lines-per-function -- one recovery interleaving and its cleanup
it('reconnecting LISTEN after an unmentioned chat message tells the board to reread conversations', async () => {
  const g = await createGroupWorld('sol357reconnect');
  const { world } = g.chat.harness;
  const caller = world.mia;
  if (caller.personId === null) throw new Error('fixture has no person');
  const underlying = connectListener(world.db.appUrl);
  let deliver = true;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced by the recovery callback
  let reconnect = () => {};
  const listener: Listener = {
    log: underlying.log,
    close: () => underlying.close(),
    async listen(channel, onPayload, onListening) {
      reconnect = onListening;
      await underlying.listen(
        channel,
        (payload) => {
          if (deliver) onPayload(payload);
        },
        onListening,
      );
    },
  };
  const topics = await startLiveTopics(listener);
  const writes: string[] = [];
  const stops: (() => void | Promise<void>)[] = [];
  let aborted = false;
  const stream: LiveStream = {
    get aborted() {
      return aborted;
    },
    onAbort(callback) {
      stops.push(callback);
    },
    abort() {
      aborted = true;
      for (const stop of stops) void stop();
    },
    writeSSE(frame) {
      writes.push(frame.event ?? '');
      return Promise.resolve();
    },
  };
  let joins = 0;
  const running = followBoard(
    stream,
    topics,
    { businessId: world.alpha, personId: caller.personId, recheckMs: 100_000 },
    {
      async joinedAs() {
        const answer = await joinLiveBoard(world.db.app, world.alpha, caller.presented);
        joins += 1;
        return 'personId' in answer ? answer.personId : undefined;
      },
      reach: (person) => boardReach(world.db.app, world.alpha, caller.presented, person),
      shown: (person) => shownInbox(world.db.app, world.alpha, caller.presented, person),
      hears: (person, chats) =>
        hearsConversation(world.db.app, world.alpha, caller.presented, person, chats),
    },
  );
  const direct: string[] = [];
  const unsubscribe = topics.subscribe(world.alpha, g.conversationId, (signal) =>
    direct.push(signal),
  );
  try {
    await expect.poll(() => writes).toContain('resync');
    const before = await g.viewOf(caller);
    const digestBefore = await Promise.all([
      boardReach(world.db.app, world.alpha, caller.presented, caller.personId),
      shownInbox(world.db.app, world.alpha, caller.presented, caller.personId),
    ]);
    // A transport outage loses the payload; recovery invokes the real listener contract.
    deliver = false;
    expect((await g.say(g.chat.tess, 'Unread message posted while LISTEN was down')).status).toBe(
      200,
    );
    expect((await g.viewOf(caller))?.unread).toBe(Number(before?.unread) + 1);
    expect(
      await Promise.all([
        boardReach(world.db.app, world.alpha, caller.presented, caller.personId),
        shownInbox(world.db.app, world.alpha, caller.presented, caller.personId),
      ]),
    ).toEqual(digestBefore);
    const joinedBefore = joins;
    deliver = true;
    reconnect();
    await expect.poll(() => joins).toBeGreaterThan(joinedBefore);
    expect(direct).toContain('resync');
    await expect
      .poll(() => writes.filter((event) => event === 'resync' || event === 'conversation').length)
      .toBeGreaterThan(1);
  } finally {
    unsubscribe();
    stream.abort();
    await running;
    await topics.close();
    await g.chat.harness.close();
  }
}, 180_000);
