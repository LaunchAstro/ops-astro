// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, require-await, unicorn/consistent-function-scoping -- a reviewer's proof, its body kept as written */
import { Context } from 'hono';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createGather } from '../../apps/api/gather.ts';
import { followBoard } from '../../apps/api/live-board.ts';
import { boardQuestions, mayJoinBoard } from '../../apps/api/live-watching.ts';
import type { BoardSignal, LiveTopics } from '../../apps/api/live.ts';
import type { LiveStream } from '../../apps/api/live-stream.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules } from '../runtime/schedules-harness.ts';

function latch() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

function tab(firstWrite?: Promise<void>) {
  const frames: string[] = [];
  const callbacks: (() => void | Promise<void>)[] = [];
  let aborted = false;
  const stream: LiveStream = {
    get aborted() {
      return aborted;
    },
    onAbort(callback) {
      callbacks.push(callback);
    },
    async writeSSE(frame) {
      frames.push(frame.event ?? '');
      if (frames.length === 1) await firstWrite;
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const callback of callbacks) void callback();
    },
  };
  return { stream, frames };
}

it("a queued board event rechecks a remapped login before sending the previous person's resync", async () => {
  const s = await openSchedules('sol1368remap', 1_000_000);
  const blocked = latch();
  const fast = tab();
  const slow = tab(blocked.held);
  const subscribers = new Set<(signal: BoardSignal) => void>();
  const topics: LiveTopics = {
    listening: true,
    hears: async () => true,
    close: async () => {},
    subscribe: () => () => {},
    subscribeBoard: (_business, _person, hear) => {
      subscribers.add(hear);
      return () => {
        subscribers.delete(hear);
      };
    },
  };
  const running: Promise<void>[] = [];
  const resumed = latch();
  try {
    const oldTask = await createTask(s, 'visible to the previous person');
    const otherTask = await createTask(s, 'visible to the new person');
    const second = await enrol(s.db.app, s.business, 'new-reader');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, second, 'read', { kind: 'record', id: otherTask });
    });
    const door = {
      database: s.db.app,
      verify: async () => s.decider.presented,
    };
    const gather = createGather();
    const context = () =>
      new Context(
        new Request('http://api.test/api/b/alpha/live', {
          headers: { authorization: 'Bearer same-verified-credential' },
        }),
      );
    for (const opened of [fast, slow]) {
      const questions = boardQuestions(door, context(), s.business, gather);
      let joins = 0;
      running.push(
        followBoard(
          opened.stream,
          topics,
          {
            businessId: s.business,
            personId: s.decider.personId,
            recheckMs: 60_000,
          },
          {
            ...questions,
            joinedAs: async () => {
              const answer = await questions.joinedAs();
              joins += 1;
              if (opened === slow && joins === 2) resumed.release();
              return answer;
            },
          },
        ),
      );
    }
    await expect.poll(() => [fast.frames.length, slow.frames.length]).toEqual([1, 1]);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query('update public.records set data = data where id = $1', [oldTask]);
    });
    for (const hear of subscribers) hear({ kind: 'task', taskId: oldTask });
    await expect.poll(() => fast.frames.length).toBe(2);
    await s.db.admin.execute(
      'update public.person_logins set person_id = $2 where business_id = $1 and person_id = $3 and active',
      [s.business, second.personId, s.decider.personId],
    );
    expect(await mayJoinBoard(door, context(), s.business)).toEqual({ personId: second.personId });
    blocked.release();
    await resumed.held;
    await setImmediate();
    expect(
      slow.frames,
      "the slow board used the fast board's cached join for the previous person",
    ).toEqual(['resync']);
  } finally {
    blocked.release();
    fast.stream.abort();
    slow.stream.abort();
    await Promise.allSettled(running);
    await s.db.drop();
  }
}, 30_000);
