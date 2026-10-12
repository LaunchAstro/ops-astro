// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Two of the dock's isolation worlds built at once, each on its own fresh
// database: each world's two stored clients are its own, made by its own
// manager and linked from its own two reader tasks, and no client, task or
// actor of one is in the other's database. Each database is read on a
// connection opened for that read alone.

import { expect, it, vi } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { isolationWorld, serverUrl, type World } from './mp-3-1-isolation-world.tsx';

// The two worlds' `beforeAll` builds run side by side, not one after the other.
vi.setConfig({ sequence: { hooks: 'parallel' } });

const first = isolationWorld('worlds_at_once_a');
const second = isolationWorld('worlds_at_once_b');

interface Seen {
  readonly built: { readonly from: number; readonly to: number };
  readonly clients: readonly { readonly id: string; readonly by: string }[];
  /** Each task linked to a stored client, with the client it names. */
  readonly linked: readonly { readonly task: string; readonly client: string }[];
  readonly records: readonly string[];
  readonly actors: readonly string[];
}

/** What one world's database holds, read on a connection of its own. */
async function seen(w: World): Promise<Seen> {
  if (serverUrl === undefined) throw new Error('no database server is configured');
  const url = new URL(serverUrl);
  url.pathname = `/${w.fixture.db.name}`;
  const own = connectAsAdmin(url.toString());
  try {
    const [built] = await own.execute<{ readonly from: Date; readonly to: Date }>(
      `select (select min(created_at) from public.records) as from,
              (select max(created_at) from public.clients) as to`,
    );
    const clients = await own.execute<{ readonly id: string; readonly by: string }>(
      'select id::text, created_by_actor_id::text as by from public.clients order by id',
    );
    const linked = await own.execute<{ readonly task: string; readonly client: string }>(
      `select r.id::text as task, r.uuid_7::text as client from public.records r
        where r.uuid_7 is not null order by r.id`,
    );
    const records = await own.execute<{ readonly id: string }>(
      'select id::text from public.records',
    );
    const actors = await own.execute<{ readonly id: string }>('select id::text from public.actors');
    return {
      built: { from: Number(built?.from), to: Number(built?.to) },
      clients,
      linked,
      records: records.map(({ id }) => id),
      actors: actors.map(({ id }) => id),
    };
  } finally {
    await own.close();
  }
}

const shared = (one: readonly string[], other: readonly string[]): string[] =>
  one.filter((id) => other.includes(id));

it.skipIf(serverUrl === undefined)(
  'two isolation worlds built at once each link their reader tasks to two stored clients of their own',
  async () => {
    const [a, b] = await Promise.all([seen(first), seen(second)]);
    // Built at once: each world's setup began before the other's finished.
    expect(a.built.from).toBeLessThan(b.built.to);
    expect(b.built.from).toBeLessThan(a.built.to);
    for (const [w, world] of [
      [first, a],
      [second, b],
    ] as const) {
      expect(world.clients).toHaveLength(2);
      expect(world.clients.every(({ by }) => by === w.controls.manager.actorId)).toBe(true);
      expect(world.linked).toHaveLength(2);
      expect(world.linked.map(({ client }) => client).toSorted()).toEqual(
        world.clients.map(({ id }) => id),
      );
      expect(world.linked.map(({ task }) => task)).toContain(w.taskOne);
    }
    expect(
      shared(
        a.clients.map(({ id }) => id),
        b.clients.map(({ id }) => id),
      ),
    ).toEqual([]);
    expect(shared(a.records, b.records)).toEqual([]);
    expect(shared(a.actors, b.actors)).toEqual([]);
    expect(first.fixture.db.name).not.toBe(second.fixture.db.name);
  },
);
