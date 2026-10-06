// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 at join: the caller stays the same authorised staff person, but their
// display name changes between the seat lookup and the first recheck. That
// recheck leaves every seat and asks each task again for the renamed person;
// while that second question is in flight the stream has no seat, so it must
// not announce one. The `seat` frame names a registered, admitted seat: a mark
// sent the moment it arrives is taken.

import { randomUUID } from 'node:crypto';
import type { SSEStreamingApi } from 'hono/streaming';
import { setTimeout } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { follow, type Seated, type Watching } from '../../apps/api/live-follow.ts';
import { createLivePresence } from '../../apps/api/live-presence.ts';
import { startLiveTopics } from '../../apps/api/live.ts';

const business = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const task = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const noop = (): void => {};

/** A stream that records each frame's event, calls `onSeat` as `seat` is written, and can be aborted. */
function recording(frames: string[], onSeat: () => void): SSEStreamingApi {
  let aborted = false;
  const onAbort: (() => void)[] = [];
  const stream = {
    get aborted() {
      return aborted;
    },
    onAbort(callback: () => void) {
      onAbort.push(callback);
    },
    writeSSE(frame: { event: string }) {
      frames.push(frame.event);
      if (frame.event === 'seat') onSeat();
      return Promise.resolve();
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const callback of onAbort) callback();
    },
  };
  return stream as unknown as SSEStreamingApi;
}

/** A listener with no external signals. */
const silent = {
  listen: (_channel: string, _payload: unknown, onListening: () => void) => {
    onListening();
    return Promise.resolve();
  },
  close: () => Promise.resolve(),
} as unknown as Listener;

/** Every question admits the person; the second, the replacement admission, waits for `release`. */
function secondAdmissionHeld(): { asks: Watching; asked: () => number; release: () => void } {
  let asked = 0;
  let release = noop;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asks: Watching = {
    businessId: business,
    atDoor: (taskIds) => Promise.resolve(taskIds.map(() => person)),
    async again() {
      asked += 1;
      if (asked === 2) await held;
      return person;
    },
  };
  return { asks, asked: () => asked, release };
}

it('a person renamed during the first recheck is announced a seat only once that seat is sat', async () => {
  const topics = await startLiveTopics(silent);
  const presence = createLivePresence();
  const seatId = randomUUID();
  const seated: Seated = {
    presence,
    session: { sessionId: seatId, personId: person, name: 'Old', side: 'staff' },
    sitter: () => Promise.resolve({ personId: person, name: 'New', side: 'staff' }),
  };
  const { asks, asked, release } = secondAdmissionHeld();
  const frames: string[] = [];
  const markedOnSeat: boolean[] = [];
  // The tab marks the field it holds the moment it learns its seat.
  const stream = recording(frames, () => {
    markedOnSeat.push(presence.mark(business, task, seatId, person, 'title'));
  });

  const running = follow(
    stream,
    { topics, recheckMs: 60_000 },
    [{ label: `task:${task}`, taskId: task }],
    asks,
    seated,
  );
  await vi.waitFor(() => expect(asked()).toBe(2));
  await setTimeout(50);
  release();
  await vi.waitFor(() => expect(frames).toContain('seat'));
  await vi.waitFor(() =>
    expect(
      presence.mark(business, task, seatId, person, 'status'),
      'the seat is sat in the end',
    ).toBe(true),
  );

  expect(markedOnSeat, 'a mark sent on the seat announcement reaches a sat seat').toEqual([true]);

  stream.abort();
  await running;
  await topics.close();
  expect(presence.held, 'the stream leaves nothing held').toBe(0);
});
