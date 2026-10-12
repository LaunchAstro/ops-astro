// SPDX-License-Identifier: AGPL-3.0-only
//
// `map_summary_refresh` takes the map's advisory lock to the end of its
// transaction, then deletes and rebuilds the map's frontier from what each of
// its statements reads. Each schedule here holds one writer of the map open on
// its own connection after its refresh, sees a second writer parked on that
// lock in `pg_stat_activity`, and only then lets the first go, so the second's
// rebuild runs after the first commits: the frontier holds each open,
// unclaimed and unarchived ticket once, whichever writer went first. A holder
// that dies mid-refresh lets the waiter through.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waiterOf, type Held } from '../support/lock-wait-race.ts';
import { agentOwnedBy } from '../commands/fixture.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let w: WayfinderWorld;
let owner: Decider;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('wfrace', 'wfrace');
  owner = await w.decider('owner');
  await w.grant(owner, 'assign');
}, 180_000);

afterAll(async () => {
  if (serverUrl === undefined) return;
  await w?.drop();
});

type Execute = AdminConnection['execute'];

/** A map holding three open, unblocked research tickets. */
const mapOfThree = async () => {
  const title = `race ${randomUUID().slice(0, 6)}`;
  const answer = await w.as(owner, {
    command: 'map.chart',
    title,
    tickets: ['a', 'b', 'c'].map((ref) => ({ ref, title: `${title} ${ref}`, type: 'research' })),
  });
  const map = must(answer, 'map.chart').id;
  const refs = (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets ?? {};
  return { map, tickets: ['a', 'b', 'c'].map((ref) => String(refs[ref])) };
};

/** The frontier's tickets in position order, and whether the positions run 1..n. */
const frontierOf = async (map: string) => {
  const found = await w.db.admin.execute<{ readonly ticket: string; readonly position: number }>(
    `select ticket_id::text as ticket, position from public.map_frontier
      where map_id = $1 order by position`,
    [map],
  );
  return {
    tickets: found.map((row) => row.ticket).toSorted(),
    dense: found.every((row, index) => row.position === index + 1),
  };
};

const sorted = (ids: readonly string[]) => ({ tickets: ids.toSorted(), dense: true });

/** The map's refresh, run in the owner's transaction under the world's business. */
const refresh =
  (map: string) =>
  async (execute: Execute): Promise<void> => {
    await execute(`select set_config('app.business_id', $1, true)`, [w.business]);
    await execute(`select public.map_summary_refresh($1)`, [map]);
  };

/** A raw write of one key into a ticket's data, as the owner, whose trigger refreshes its map. */
const writeKey =
  (ticket: string, key: 'agent' | 'archived_at', value: string) =>
  async (execute: Execute): Promise<void> => {
    await execute(`select set_config('app.business_id', $1, true)`, [w.business]);
    await execute(
      `update public.records set data = data || jsonb_build_object($2::text, $3::text)
        where id = $1`,
      [ticket, key, value],
    );
  };

/** `racing` is started behind `first`, seen parked on it, then `first` commits. */
async function behind<T>(first: Held, racing: () => Promise<T>): Promise<T> {
  // Settled as it starts, so a refusal is never an unhandled rejection.
  const raced = Promise.allSettled([racing()]);
  try {
    await waiterOf(w.db, first);
  } finally {
    await first.letGo();
  }
  const [settled] = await raced;
  if (settled.status === 'rejected') throw settled.reason;
  return settled.value;
}

/** A second refresh, held on its own connection behind `first`, then committed. */
const refreshBehind = async (first: Held, map: string): Promise<void> => {
  const second = await behind(first, async () => await hold(w.db, refresh(map)));
  await second.letGo();
};

const assign = async (ticket: string, agent: string) =>
  await w.as(owner, {
    command: 'task.assign',
    recordId: ticket,
    expectedRevision: await w.revisionOf(ticket),
    fields: { agent },
  });

it('two refreshes of one map at once leave each open ticket on its frontier once', async () => {
  const { map, tickets } = await mapOfThree();
  await refreshBehind(await hold(w.db, refresh(map)), map);
  expect(await frontierOf(map)).toStrictEqual(sorted(tickets));
  const [summary] = await w.db.admin.execute<{ readonly open: number }>(
    `select open_tickets::int as open from public.map_summaries where map_id = $1`,
    [map],
  );
  expect(summary).toStrictEqual({ open: 3 });
  // Run again, the refresh gives the same frontier.
  await (await hold(w.db, refresh(map))).letGo();
  expect(await frontierOf(map)).toStrictEqual(sorted(tickets));
});

it('a ticket assigned while another refresh holds its map leaves the frontier', async () => {
  const { map, tickets } = await mapOfThree();
  const agent = await agentOwnedBy(w.db.app, w.business, owner.personId);
  const [a, ...rest] = tickets as [string, ...string[]];
  const first = await hold(w.db, refresh(map));
  must(await behind(first, async () => await assign(a, agent)), 'task.assign');
  expect(await frontierOf(map)).toStrictEqual(sorted(rest));
});

it('a refresh waiting behind an assignment does not put the assigned ticket back', async () => {
  const { map, tickets } = await mapOfThree();
  const agent = await agentOwnedBy(w.db.app, w.business, owner.personId);
  const [a, ...rest] = tickets as [string, ...string[]];
  await refreshBehind(await hold(w.db, writeKey(a, 'agent', agent)), map);
  expect(await frontierOf(map)).toStrictEqual(sorted(rest));
});

it('a map completed while another refresh holds it leaves no frontier', async () => {
  const { map } = await mapOfThree();
  const first = await hold(w.db, refresh(map));
  const completed = await behind(
    first,
    async () =>
      await w.as(owner, {
        command: 'task.complete',
        recordId: map,
        expectedRevision: await w.revisionOf(map),
      }),
  );
  must(completed, 'task.complete');
  expect(await frontierOf(map)).toStrictEqual(sorted([]));
});

it('a refresh waiting behind an archive does not put the archived ticket back', async () => {
  const { map, tickets } = await mapOfThree();
  const [a, ...rest] = tickets as [string, ...string[]];
  const archived = writeKey(a, 'archived_at', new Date().toISOString());
  await refreshBehind(await hold(w.db, archived), map);
  expect(await frontierOf(map)).toStrictEqual(sorted(rest));
});

it('a refresh whose backend dies mid-run lets the waiting assignment through', async () => {
  const { map, tickets } = await mapOfThree();
  const agent = await agentOwnedBy(w.db.app, w.business, owner.personId);
  const [a, ...rest] = tickets as [string, ...string[]];
  const first = await hold(w.db, refresh(map));
  const assigning = Promise.allSettled([assign(a, agent)]);
  await waiterOf(w.db, first);
  await w.db.admin.execute('select pg_terminate_backend($1)', [first.pid]);
  const [assigned] = await assigning;
  expect(assigned.status).toBe('fulfilled');
  if (assigned.status === 'fulfilled') must(assigned.value, 'task.assign');
  await first.letGo().catch(() => null);
  expect(await frontierOf(map)).toStrictEqual(sorted(rest));
});
