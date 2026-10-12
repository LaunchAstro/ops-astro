// SPDX-License-Identifier: AGPL-3.0-only
//
// The decision item is raised as a frontier row lands and taken back at
// commit when its ticket left the frontier again in the same transaction. Here
// one transaction lands and unlands a ticket (its blocking link deleted, then
// put back), so only the frontier at commit decides: an item only for a ticket
// still on it. The take-back never removes an item another transaction raised,
// committed before or while this one ran, and an item once cleared is never
// raised again, even while the clear is still in flight on another connection.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import {
  blockingLink,
  chartBlocked,
  decisionsOn,
  holdTwinItem,
  inBusinessTransaction,
  letTwinGo,
  onFrontier,
  Planned,
  relink,
  unlink,
  waitersOf,
} from './frontier-decision-race.ts';
import { codeOf, must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('the commit take-back of a decision item', () => {
  let w: WayfinderWorld;
  let owner: Decider;

  beforeAll(async () => {
    w = await wayfinderWorld('frontiertakeback', 'frontiertakeback');
    owner = await w.decider('owner');
  }, 180_000);

  afterAll(async () => await w?.drop());

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });
  const open = { business: '', recipient: '', state: 'open' };
  const item = (state: string) => ({
    ...open,
    business: w.business,
    recipient: owner.personId,
    state,
  });

  const itemIds = async (ticket: string) =>
    (
      await w.db.admin.execute<{ id: string }>(
        `select id::text as id from public.inbox_items
          where subject_record_id = $1 and reason = 'decision' order by id`,
        [ticket],
      )
    ).map((row) => row.id);

  /** Lands `g` with `a`'s completion, then puts it back behind `a`: one open item, raised earlier. */
  async function raisedThenBlocked(): Promise<{ a: string; g: string }> {
    const { tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    must(await w.as(owner, { command: 'task.complete', ...(await at(a)) }), 'task.complete');
    must(
      await w.as(owner, { command: 'task.reopen', reason: 'More to read', ...(await at(a)) }),
      'task.reopen',
    );
    expect(await onFrontier(w, g)).toBe(false);
    expect(await decisionsOn(w, g)).toStrictEqual([item('open')]);
    return { a, g };
  }

  it('a ticket that lands and leaves in one transaction keeps no decision item', async () => {
    const { tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    await inBusinessTransaction(w, async (execute) => {
      const link = await blockingLink(execute, a, g);
      await unlink(execute, a, g);
      await relink(execute, link);
    });
    expect(await onFrontier(w, g)).toBe(false);
    expect(await decisionsOn(w, g)).toStrictEqual([]);
  });

  it('a ticket that leaves and lands again in one transaction keeps its one item', async () => {
    const { tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    await inBusinessTransaction(w, async (execute) => {
      const link = await blockingLink(execute, a, g);
      await unlink(execute, a, g);
      await relink(execute, link);
      await unlink(execute, a, g);
    });
    expect(await onFrontier(w, g)).toBe(true);
    expect(await decisionsOn(w, g)).toStrictEqual([item('open')]);
  });

  it('a chart raises the item of the decision ticket it leaves unblocked and not of the blocked one', async () => {
    const answer = await w.as(owner, {
      command: 'map.chart',
      title: 'chart with both',
      tickets: [
        { ref: 'a', title: 'research', type: 'research' },
        { ref: 'g', title: 'blocked decision', type: 'grilling', blockedBy: ['a'] },
        { ref: 'p', title: 'free prototype', type: 'prototype' },
      ],
    });
    must(answer, 'map.chart');
    const { g, p } = (answer as unknown as { detail: { tickets: Record<string, string> } }).detail
      .tickets;
    expect(await decisionsOn(w, g!)).toStrictEqual([]);
    expect(await onFrontier(w, p!)).toBe(true);
    expect(await decisionsOn(w, p!)).toStrictEqual([item('open')]);
  });

  it('an item an earlier transaction raised survives a later one that lands and leaves the ticket', async () => {
    const { a, g } = await raisedThenBlocked();
    const before = await itemIds(g);
    await inBusinessTransaction(w, async (execute) => {
      const link = await blockingLink(execute, a, g);
      await unlink(execute, a, g);
      await relink(execute, link);
    });
    expect(await itemIds(g)).toStrictEqual(before);
    expect(await decisionsOn(w, g)).toStrictEqual([item('open')]);
  });

  it("a twin's item committed while a transaction lands and leaves the ticket survives its take-back", async () => {
    const { tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    const twin = await holdTwinItem(w, g, owner.personId, 'commit');
    let moving: Promise<void> | undefined;
    try {
      moving = inBusinessTransaction(w, async (execute) => {
        const link = await blockingLink(execute, a, g);
        // Lands `g`: the raise reads no item and its insert waits on the twin's.
        await unlink(execute, a, g);
        await relink(execute, link);
      });
      await waitersOf(w, twin.pid, 1);
    } finally {
      await letTwinGo(twin);
    }
    await moving;
    expect(await onFrontier(w, g)).toBe(false);
    expect(await decisionsOn(w, g)).toStrictEqual([item('open')]);
  });

  it('a cleared item is never raised again when its ticket lands once more', async () => {
    const { a, g } = await raisedThenBlocked();
    await w.db.admin.execute(
      `update public.inbox_items set work_state = 'cleared', closed_at = now(),
              closed_by_person_id = recipient_person_id
        where subject_record_id = $1 and reason = 'decision'`,
      [g],
    );
    must(await w.as(owner, { command: 'task.complete', ...(await at(a)) }), 'task.complete');
    expect(await onFrontier(w, g)).toBe(true);
    expect(await decisionsOn(w, g)).toStrictEqual([item('cleared')]);
  });

  it.each([
    ['commits', 'cleared'],
    ['rolls back', 'open'],
  ] as const)(
    'a clear in flight on another connection while the ticket lands again %s, and no second item is raised',
    async (end, state) => {
      const { a, g } = await raisedThenBlocked();
      const clearing = await hold(
        w.db,
        async (execute) => {
          await execute(
            `update public.inbox_items set work_state = 'cleared', closed_at = now(),
                    closed_by_person_id = recipient_person_id
              where subject_record_id = $1 and reason = 'decision'`,
            [g],
          );
        },
        end === 'rolls back' ? () => Promise.reject(new Planned('rolled back')) : undefined,
      );
      try {
        expect(codeOf(await w.as(owner, { command: 'task.complete', ...(await at(a)) }))).toBe(
          'applied',
        );
      } finally {
        await letTwinGo(clearing);
      }
      expect(await onFrontier(w, g)).toBe(true);
      expect(await decisionsOn(w, g)).toStrictEqual([item(state)]);
    },
  );
});
