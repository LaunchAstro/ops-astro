// SPDX-License-Identifier: AGPL-3.0-only
//
// The budget-stop race proofs' shared half: a run waiting at its budget with
// its stopped step's cost unknown, two commands queued in a named order on
// connections of their own behind a third holding one row, and a command
// whose commit a relay cuts at a named point. Each file opens its own world
// (`useBrokerWorld`).

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { hold } from '../support/lock-wait-race.ts';
import {
  asPerson,
  codeOf,
  cutProxy,
  racer,
  settle,
  type CutPoint,
} from '../runtime/schedules-harness.ts';
import { PRICED } from '../runtime/t2d-harness.ts';
import { s } from './broker-world.ts';
import { one } from './budget-answers-world.ts';
import { dispatchedWithOneCall, stopIt, type PersonWork } from './observed-hold-world.ts';

export interface Waiting {
  readonly w: PersonWork;
  readonly runId: string;
  readonly askId: string;
}

/**
 * Waiting on one ask, the stopped step's cost observed above the hold and kept
 * unknown. With `spentWhole`, its one call billed the whole hold, so a
 * `nothing_happened` leaves the step nothing to hold.
 */
export async function waitingUnknown(spentWhole: boolean): Promise<Waiting> {
  const { w, lease } = await dispatchedWithOneCall(false);
  if (spentWhole) {
    // The replay never answers that high: the settled call's row is moved as the broker's settle moves it.
    await one(
      `update public.model_calls set observed_minor = reserved_minor, actual_minor = reserved_minor
        where lease_id = $1 and state = 'settled' returning id`,
      [lease.leaseId],
    );
  }
  const { runId, askId } = await stopIt(w, lease);
  const observed = await asPerson(s, {
    command: 'task.observe',
    operationId: randomUUID(),
    ...lease,
    attemptId: w.attemptId,
    outcome: 'failed',
    usage: PRICED,
  });
  expect(codeOf(observed)).toBe('BUDGET_UNAVAILABLE');
  return { w, runId, askId };
}

/** A command through the person entry, as `who`, on `database`. */
export const as = async (
  database: Database,
  who: Member,
  body: Readonly<Record<string, unknown>>,
): Promise<CommandResult> =>
  await executeCommand(database, s.business, who.presented, 'api', body as never);

export type Racer = (database: Database) => Promise<CommandResult>;

/** The backend of each racer's one connection. */
async function pidsOf(...databases: readonly Database[]): Promise<readonly number[]> {
  return await Promise.all(
    databases.map(
      async (database) =>
        await database.withBusiness(s.business, async (tx) => {
          const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          return Number(me?.pid);
        }),
    ),
  );
}

/** Waits until `count` backends wait on a lock any of `blockers` holds. */
async function waiting(blockers: readonly number[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity a
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and pg_blocking_pids(a.pid) && $1::int[]`,
      [blockers],
    );
    if ((row?.n ?? 0) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(25);
  }
  throw new Error(
    `fewer than ${String(count)} racers ever waited: the schedule was not established`,
  );
}

/**
 * `first` then `second`, each on a connection of its own, seen queued in that
 * order behind a third connection holding `table`'s row `id` for update, then
 * let through. A racer that throws rethrows here.
 */
export async function queued(
  held: { readonly table: string; readonly id: string },
  first: Racer,
  second: Racer,
): Promise<readonly CommandResult[]> {
  const holder = await hold(s.db, async (execute) => {
    await execute(`select id from public.${held.table} where id = $1 for update`, [held.id]);
  });
  const a = racer(s);
  const b = racer(s);
  try {
    const blockers = [holder.pid, ...(await pidsOf(a, b))];
    const ahead = first(a);
    await waiting(blockers, 1);
    const behind = second(b);
    await waiting(blockers, 2);
    await holder.letGo();
    const results = await settle([ahead, behind]);
    return results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  } finally {
    await holder.letGo();
    await a.close();
    await b.close();
  }
}

export const POINTS: readonly CutPoint[] = ['before-commit', 'after-commit'];

/** Runs `send` on a connection through a relay that cuts it at `point`; the caller sees it fail. */
export async function cutAt(point: CutPoint, send: Racer): Promise<void> {
  const proxy = await cutProxy(s.db.appUrl, point);
  const cut = racer(s, proxy.url);
  try {
    const [interrupted] = await settle([send(cut)]);
    expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
    expect(interrupted?.status).toBe('rejected');
  } finally {
    // A client whose socket the relay killed may never finish ending: give it a second.
    await Promise.race([cut.close().catch(() => null), delay(1_000)]);
    await proxy.close();
  }
}
