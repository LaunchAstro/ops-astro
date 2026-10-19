// SPDX-License-Identifier: AGPL-3.0-only
//
// Two of the agent's correction requests at the real door at once (#1717,
// S2090-2), on the draft world (`agent-draft-world.ts`). The world's own app
// pool holds one connection, which would run them one after the other, so each
// request goes through a pool of its own, on its own backend. A third
// connection holds a share lock on `live_corrections` until both have reached
// their insert and wait there, so the two transactions overlap at the
// one-per-plan index; the lock is then let go.

import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import type { Work } from '../runtime/schedules-harness.ts';
import { agentBroker, type Detail } from './agent-draft-world.ts';
import { asWorker, door, s, type Answer } from './run-stop-world.ts';

/** `database`, noting the backend each of its transactions ran on. */
const noting = (database: Database, backends: Set<number>): Database => ({
  ...database,
  withBusiness: async (business, run) =>
    await database.withBusiness(business, async (tx) => {
      const [backend] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      if (backend !== undefined) backends.add(backend.pid);
      return await run(tx);
    }),
});

/** How many backends wait on a lock at the correction insert, polled until `want` or 10 s. */
async function waitingAtTheInsert(want: number): Promise<number> {
  let seen = 0;
  for (let tries = 0; tries < 100 && seen < want; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a poll, one read at a time
    const [found] = await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%insert into public.live_corrections%'`,
    );
    seen = Number(found?.n);
    // oxlint-disable-next-line no-await-in-loop -- the poll's pause
    if (seen < want) await pause(100);
  }
  return seen;
}

/** A promise, and the call that settles it. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    settle = done;
  });
  return { promise, resolve: () => settle?.() };
}

/** The asks' answers, the backends each ran on, and how many waited at the insert together. */
export interface AtOnce {
  readonly answers: readonly Answer[];
  readonly backends: readonly (readonly number[])[];
  readonly waited: number;
}

/** The agent's requests with `bodies` on `work`, each on its own backend, meeting at the insert. */
export async function requestsAtOnce(work: Work, bodies: readonly Detail[]): Promise<AtOnce> {
  const pools = bodies.map(() => connect(s.db.appUrl, { source: 'runtime' }));
  const holder = connect(s.db.appUrl, { source: 'runtime' });
  const seen = bodies.map(() => new Set<number>());
  const locked = deferred();
  const released = deferred();
  const holding = holder.withBusiness(s.business, async (tx) => {
    await tx.query('lock table public.live_corrections in share mode');
    locked.resolve();
    await released.promise;
  });
  try {
    await locked.promise;
    const asked = bodies.map(
      async (body, n) =>
        await asWorker(
          door(noting(pools[n] as Database, seen[n] as Set<number>), agentBroker()),
          work,
          'live_correction/request',
          { operationId: randomUUID(), ...body },
        ),
    );
    const waited = await waitingAtTheInsert(bodies.length);
    released.resolve();
    await holding;
    return {
      answers: await Promise.all(asked),
      backends: seen.map((one) => Array.from(one)),
      waited,
    };
  } finally {
    released.resolve();
    await Promise.all([...pools, holder].map(async (pool) => await pool.close()));
  }
}
