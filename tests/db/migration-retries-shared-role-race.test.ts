// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-007.3 through the runner. 0046 repairs the cluster's lookup role when it
// differs, so two databases migrating at once can both judge the old row: the
// second's ALTER waits on the first's uncommitted change and then fails with
// XX000, "tuple concurrently updated". 0046 is history and cannot change, so
// the runner rolls that run back and applies it again, and the second run
// then finds the role repaired. Run alone on a disposable cluster: the case
// changes the shared lookup role and puts it back.

import { setTimeout as pause } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const url = databaseUrlFromEnvironment();
const migrations = readMigrations('migrations');
const through = (last: string) => migrations.filter((m) => m.version.slice(0, 4) <= last);
const COMMENT =
  migrations
    .find((m) => m.version === '0046_business_lookup')
    ?.statements.find((s) => s.startsWith('comment on role')) ?? '';
const LOOKUP_BYPASS = "select rolbypassrls from pg_roles where rolname = 'ops_astro_lookup'";

function unopened(): never {
  throw new Error('the gate opened before it was made');
}

function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = unopened;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The run's outcome: `ok`, or the SQLSTATE of the statement that ended it. */
const settle = async (run: Promise<unknown>): Promise<string> =>
  await run.then(
    () => 'ok',
    (error: { code?: string; cause?: { code?: string } }) =>
      error.cause?.code ?? error.code ?? 'failed',
  );

/** Whether a backend on `database` comes to wait on a lock within four seconds. */
async function waitsOnLock(observer: AdminConnection, database: string): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- poll until the backend waits
    const [row] = await observer.execute<{ waiting: boolean }>(
      `select exists (select from pg_stat_activity
                       where datname = $1 and wait_event_type = 'Lock') as waiting`,
      [database],
    );
    if (row?.waiting === true) return true;
    // oxlint-disable-next-line no-await-in-loop -- the next poll follows this pause
    await pause(20);
  }
  return false;
}

/**
 * Hold 0046's own COMMENT ON ROLE open from another database until released.
 * It locks the role across the cluster until commit, so a run reaching that
 * statement waits there with its ALTER of the role made and uncommitted.
 */
async function holdComment(
  holder: AdminConnection,
): Promise<{ readonly release: () => void; readonly done: Promise<unknown> }> {
  const held = gate<void>();
  const released = gate<void>();
  const done = holder.transaction(async (query) => {
    await query(COMMENT);
    held.resolve();
    await released.promise;
  });
  await Promise.race([held.promise, done]);
  return { release: () => released.resolve(), done };
}

it.skipIf(url === undefined)(
  'two databases migrating through 0046 at once both commit while the shared lookup role needs repair',
  async () => {
    expect(COMMENT, "0046's comment statement").not.toBe('');
    const first = await createEmptyDatabase({ part: 'role_race_runner_a' });
    const second = await createEmptyDatabase({ part: 'role_race_runner_b' });
    const observer = connectAsAdmin(url ?? '');
    const holder = connectAsAdmin(url ?? '');
    let hold: Awaited<ReturnType<typeof holdComment>> | undefined;
    let runs: Promise<string>[] = [];
    try {
      await applyMigrations(first.admin, through('0045'));
      await applyMigrations(second.admin, through('0045'));
      await observer.execute(
        `do $$ begin create role ops_astro_lookup nologin bypassrls;
         exception when duplicate_object then null; end $$`,
      );
      await observer.execute('alter role ops_astro_lookup nobypassrls');
      hold = await holdComment(holder);
      runs.push(settle(applyMigrations(first.admin, through('0046'))));
      expect(await waitsOnLock(observer, first.name), 'the first run waits at the comment').toBe(
        true,
      );
      runs.push(settle(applyMigrations(second.admin, through('0046'))));
      expect(await waitsOnLock(observer, second.name), 'the second run waits on the role').toBe(
        true,
      );
      hold.release();
      expect(await Promise.all(runs)).toEqual(['ok', 'ok']);
      runs = [];
      expect(await observer.execute(LOOKUP_BYPASS)).toEqual([{ rolbypassrls: true }]);
    } finally {
      hold?.release();
      await Promise.allSettled([hold?.done, ...runs]);
      await observer.execute('alter role ops_astro_lookup bypassrls');
      await observer.execute(COMMENT);
      await observer.close();
      await holder.close();
      await first.drop();
      await second.drop();
    }
  },
  60_000,
);
