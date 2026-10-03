// SPDX-License-Identifier: AGPL-3.0-only
//
// 20261003173600: the backup and lookup identities hold no other role. The
// repair is the cluster's, so two databases migrating at once can both find
// the same stale membership: the second must wait for the first and then
// accept the repaired role, never abort its whole run. Run alone on a
// disposable cluster: the case grants the application group to both
// identities and takes it back.

import { setTimeout as pause } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const url = databaseUrlFromEnvironment();
const IDENTITIES = ['ops_astro_backup', 'ops_astro_lookup'];
const REPAIR =
  readMigrations('migrations')
    .find((m) => m.version === '20261003173600_identity_roles_hold_no_membership')
    ?.statements.find((s) => s.includes('pg_auth_members')) ?? '';

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

/** The run's outcome: `ok`, or the SQLSTATE that ended it. */
const settle = async (run: Promise<unknown>): Promise<string> =>
  await run.then(
    () => 'ok',
    (error: { code?: string }) => error.code ?? 'failed',
  );

/** Whether the backend `pid` comes to wait on a lock within two seconds. */
async function waitsOnLock(observer: AdminConnection, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- poll until the backend waits
    const [row] = await observer.execute<{ waiting: boolean }>(
      "select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (row?.waiting === true) return true;
    // oxlint-disable-next-line no-await-in-loop -- the next poll follows this pause
    await pause(20);
  }
  return false;
}

it.skipIf(url === undefined)(
  'two databases revoking the same stale membership at once both commit, and the role holds none',
  async () => {
    expect(REPAIR, 'the repair statement').not.toBe('');
    const first = await createEmptyDatabase({ part: 'membership_race_a' });
    const second = await createEmptyDatabase({ part: 'membership_race_b' });
    const observer = connectAsAdmin(url ?? '');
    const ready = gate<void>();
    const release = gate<void>();
    const started = gate<number>();
    let runs: Promise<string>[] = [];
    try {
      await observer.execute(`grant ops_astro_app to ${IDENTITIES.join(', ')}`);
      runs.push(
        settle(
          first.admin.transaction(async (query) => {
            await query(REPAIR);
            ready.resolve();
            await release.promise;
          }),
        ),
      );
      await ready.promise;
      runs.push(
        settle(
          second.admin.transaction(async (query) => {
            const [row] = await query<{ pid: number }>('select pg_backend_pid() as pid');
            started.resolve(row?.pid ?? 0);
            await query(REPAIR);
          }),
        ),
      );
      const waited = await waitsOnLock(observer, await started.promise);
      expect(waited, 'the second repair waits on the first').toBe(true);
      release.resolve();
      expect(await Promise.all(runs)).toEqual(['ok', 'ok']);
      runs = [];
      const held = await observer.execute<{ member: string }>(
        `select m.member::regrole::text as member from pg_auth_members m
          where m.member::regrole::text = any($1)`,
        [IDENTITIES],
      );
      expect(held).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled(runs);
      await observer.execute(`revoke ops_astro_app from ${IDENTITIES.join(', ')}`);
      await observer.close();
      await first.drop();
      await second.drop();
    }
  },
  60_000,
);
