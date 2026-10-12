// SPDX-License-Identifier: AGPL-3.0-only
//
// Two writers on connections of their own move one grilling ticket onto its
// map's frontier at once. The map's refresh lock is held while both queue on
// it, so their frontier rewrites run back to back with nothing committed in
// between; each racer's raise then reads what the other committed. Whatever
// the order, the map owner holds exactly one decision item for the ticket.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  chartBlocked,
  decisionsOn,
  holdKey,
  mapRefreshKey,
  onFrontier,
  settle,
  waitersOf,
  writerOn,
  type Outcome,
  type Writer,
} from './frontier-decision-race.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

const applied = (outcome: Outcome): string =>
  'error' in outcome ? `threw ${String(outcome.error)}` : codeOf(outcome.answer);

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('two writers moving one ticket onto the frontier', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let first: Writer;
  let second: Writer;

  beforeAll(async () => {
    w = await wayfinderWorld('frontiertwo', 'frontiertwo');
    owner = await w.decider('owner');
    first = writerOn(w);
    second = writerOn(w);
  }, 180_000);

  afterAll(async () => {
    await first?.close();
    await second?.close();
    await w?.drop();
  });

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  /** Runs both writes while the map's refresh lock is held, in the order queued, then lets go. */
  async function race(
    map: string,
    one: { readonly by: Writer; readonly body: Record<string, unknown> },
    two: { readonly by: Writer; readonly body: Record<string, unknown> },
  ): Promise<readonly [Outcome, Outcome]> {
    const held = await holdKey(w, mapRefreshKey(w.business, map));
    let racing: Promise<readonly [Outcome, Outcome]> | undefined;
    try {
      const a = settle(one.by.send(owner, one.body));
      await waitersOf(w, held.pid, 1);
      const b = settle(two.by.send(owner, two.body));
      await waitersOf(w, held.pid, 2);
      racing = Promise.all([a, b]);
    } finally {
      await held.letGo();
    }
    return await racing;
  }

  it('two blockers completed at once raise one decision item for the ticket they free', async () => {
    const { map, tickets } = await chartBlocked(w, owner, ['a', 'b']);
    const g = tickets['g']!;
    const outcomes = await race(
      map,
      { by: first, body: { command: 'task.complete', ...(await at(tickets['a']!)) } },
      { by: second, body: { command: 'task.complete', ...(await at(tickets['b']!)) } },
    );
    expect(outcomes.map((outcome) => applied(outcome))).toStrictEqual(['applied', 'applied']);
    expect(await onFrontier(w, g)).toBe(true);
    expect(await decisionsOn(w, g)).toStrictEqual([
      { business: w.business, recipient: owner.personId, state: 'open' },
    ]);
  });

  it('a blocker completed while the other is trashed raises one decision item', async () => {
    const { map, tickets } = await chartBlocked(w, owner, ['a', 'b']);
    const g = tickets['g']!;
    const outcomes = await race(
      map,
      { by: first, body: { command: 'task.trash', ...(await at(tickets['b']!)) } },
      { by: second, body: { command: 'task.complete', ...(await at(tickets['a']!)) } },
    );
    expect(outcomes.map((outcome) => applied(outcome))).toStrictEqual(['applied', 'applied']);
    expect(await onFrontier(w, g)).toBe(true);
    expect(await decisionsOn(w, g)).toStrictEqual([
      { business: w.business, recipient: owner.personId, state: 'open' },
    ]);
  });

  it('a frontier rewrite racing the write that lands the ticket raises no second item', async () => {
    const { map, tickets } = await chartBlocked(w, owner, ['a', 'b']);
    const g = tickets['g']!;
    must(await w.as(owner, { command: 'task.complete', ...(await at(tickets['b']!)) }));
    // `c` sits on the same map's frontier and has nothing to do with `g`: completing it
    // rewrites the frontier, `g` with it, after or before `a`'s completion lands `g`.
    const c = (
      await w.create(owner, { title: 'side research' }, { taskType: 'research', parentId: map })
    ).id;
    const outcomes = await race(
      map,
      { by: first, body: { command: 'task.complete', ...(await at(tickets['a']!)) } },
      { by: second, body: { command: 'task.complete', ...(await at(c)) } },
    );
    expect(outcomes.map((outcome) => applied(outcome))).toStrictEqual(['applied', 'applied']);
    expect(await decisionsOn(w, g)).toStrictEqual([
      { business: w.business, recipient: owner.personId, state: 'open' },
    ]);
  });

  it('a blocker completed while its grilling ticket is trashed: both apply, at most one item', async () => {
    // The completion queues first, so it takes the map's lock first and raises `g`'s
    // item, which waits on the trash's lock on `g` while the trash waits on the map:
    // a deadlock the server breaks and the envelope retries once.
    const { map, tickets } = await chartBlocked(w, owner, ['a']);
    const g = tickets['g']!;
    const outcomes = await race(
      map,
      { by: first, body: { command: 'task.complete', ...(await at(tickets['a']!)) } },
      { by: second, body: { command: 'task.trash', ...(await at(g)) } },
    );
    expect(outcomes.map((outcome) => applied(outcome))).toStrictEqual(['applied', 'applied']);
    expect(await onFrontier(w, g)).toBe(false);
    expect((await decisionsOn(w, g)).length).toBeLessThanOrEqual(1);
  }, 30_000);
});

function must(result: Awaited<ReturnType<Writer['send']>>): void {
  expect(codeOf(result)).toBe('applied');
}
