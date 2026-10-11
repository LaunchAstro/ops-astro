// SPDX-License-Identifier: AGPL-3.0-only
//
// P11: a change to the business's priority stages reaches every open board
// through the board's own live stream, at once, not on its 30-second recheck.
// The digest (`boardReach`) takes the setting's revision while its reader
// reads a task, and the write itself says so on the live channel.

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { followBoard } from '../../apps/api/live-board.ts';
import { startLiveTopics, type BoardSignal } from '../../apps/api/live.ts';
import {
  boardReach,
  joinLiveBoard,
  shownInbox,
} from '../../packages/core-commands/src/reads/live-join.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connectListener } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  priorityApplied,
  priorityTask,
  priorityWorld,
  readPriority,
  setPriority,
} from '../commands/priority-stages-support.ts';
import { rankCommand, readRankTask, type RankCoreWorld } from './task-rank-core-world.ts';

let world: RankCoreWorld | undefined;
function here(): RankCoreWorld {
  if (world === undefined) throw new Error('The priority world was not made; nothing was proved.');
  return world;
}
beforeAll(async () => {
  world = await priorityWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

async function reach(by: Member = here().owner): Promise<string> {
  const w = here();
  const digest = await boardReach(w.db.app, w.business, by.presented, by.personId);
  if (digest === undefined) throw new Error('The digest refused a reader who may hold the board.');
  return digest;
}

async function change(value: readonly string[], business = here().business): Promise<void> {
  const w = here();
  const by = business === w.business ? w.owner : w.otherOwner;
  const { revision } = await readPriority(w, by, business);
  priorityApplied(await setPriority(w, value, revision, by, business));
}

it('a priority stages change moves the digest of a reader whose task it re-ranks', async () => {
  const w = here();
  await change([]);
  const made = await priorityTask(w, 'trust');
  expect((await readRankTask(w, made.id)).rank.score).toBe(504);
  const before = await reach();
  await change(['trust']);
  expect((await readRankTask(w, made.id)).rank.score).toBe(630);
  const after = await reach();
  expect(after).not.toBe(before);
  await change([]);
  expect(await reach()).not.toBe(after);
});

it('another business, another setting and a reader with no task leave the digest still', async () => {
  const w = here();
  await priorityTask(w, 'trust');
  const empty = await enrol(w.db.app, w.business, 'p11-no-task-reader');
  await w.db.app.withBusiness(w.business, (tx) =>
    grantTo(tx, empty, 'read', undefined, false, 'settings'),
  );
  expect(await joinLiveBoard(w.db.app, w.business, empty.presented)).toStrictEqual({
    personId: empty.personId,
  });
  const owner = await reach();
  const nobody = await reach(empty);
  await change(['sales'], w.foreign);
  priorityApplied(await rankCommand(w, { command: 'settings.set_retention_window', value: 31 }));
  expect(await reach()).toBe(owner);
  await change(['sales']);
  expect(await reach(empty)).toBe(nobody);
  expect(await reach()).not.toBe(owner);
});

it('the write tells only its own business, and an open board says resync without its recheck', async () => {
  const w = here();
  await priorityTask(w, 'trust');
  const topics = await startLiveTopics(connectListener(w.db.appUrl));
  const ours: BoardSignal[] = [];
  const theirs: BoardSignal[] = [];
  const stopOurs = topics.subscribeBoard(w.business, w.owner.personId, (s) => ours.push(s), noop);
  const stopTheirs = topics.subscribeBoard(
    w.foreign,
    w.otherOwner.personId,
    (s) => {
      theirs.push(s);
    },
    noop,
  );
  const stream = boardStream();
  const ask = {
    joinedAs: async () => {
      const joined = await joinLiveBoard(w.db.app, w.business, w.owner.presented);
      return isCommandRefusal(joined) ? undefined : joined.personId;
    },
    reach: async (person: string) =>
      await boardReach(w.db.app, w.business, w.owner.presented, person),
    shown: async (person: string) =>
      await shownInbox(w.db.app, w.business, w.owner.presented, person),
  };
  const followed = followBoard(
    stream,
    topics,
    // A recheck far past the test: only the write's own signal can move it.
    { businessId: w.business, personId: w.owner.personId, recheckMs: 600_000 },
    ask,
  );
  try {
    await vi.waitFor(() => expect(stream.frames).toEqual(['resync']), { timeout: 5_000 });
    await change(['enquiries']);
    await vi.waitFor(() => expect(stream.frames).toEqual(['resync', 'resync']), {
      timeout: 5_000,
    });
    expect(ours).toContainEqual({ kind: 'priority' });
    expect(theirs).toEqual([]);
  } finally {
    stream.abort();
    await followed;
    stopOurs();
    stopTheirs();
    await topics.close();
  }
}, 30_000);

const noop = async (): Promise<void> => {};

function boardStream() {
  const listeners: (() => void)[] = [];
  const stream = {
    frames: [] as string[],
    aborted: false,
    writeSSE: async (message: { readonly event?: string }): Promise<void> => {
      await Promise.resolve();
      stream.frames.push(message.event ?? '');
    },
    onAbort: (listener: () => void): void => {
      listeners.push(listener);
    },
    abort: (): void => {
      if (stream.aborted) return;
      stream.aborted = true;
      for (const listener of listeners) listener();
    },
  };
  return stream;
}
