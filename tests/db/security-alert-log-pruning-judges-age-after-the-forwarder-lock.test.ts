// SPDX-License-Identifier: AGPL-3.0-only
//
// The forwarder prunes the security alert log to ninety days in its pass,
// after it takes the forwarder lock. A pass that waited on that lock (another
// pass, or a delivery holding it while the sink answers) judges a row's age
// when it deletes, not when its transaction began: a row that crossed ninety
// days while the pass waited is gone when the pass ends.

import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import {
  advisoryLock,
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { Client, loginIn } from './backup-identity.fixture.ts';

let db: FreshDatabase;
let login: { url: string; name: string };
let forwarderDb: AdminConnection;

/** A promise and the function that settles it. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    settle = done;
  });
  return { promise, resolve: () => settle?.() };
}

/** Holds the forwarder lock in a transaction of its own until `release` is called. */
async function holdForwarderLock(): Promise<{ readonly release: () => Promise<void> }> {
  const opened = deferred();
  const released = deferred();
  const holder = db.admin.transaction(async (execute) => {
    await advisoryLock({ query: execute }, 'ops.api_events forwarder');
    opened.resolve();
    await released.promise;
  });
  await opened.promise;
  return {
    release: async () => {
      released.resolve();
      await holder;
    },
  };
}

/** Until this database has one advisory lock waiting: the pass, behind the holder. */
async function passWaits(): Promise<void> {
  await vi.waitFor(
    async () => {
      const [row] = await db.admin.execute<{ n: number }>(
        `select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database
          where d.datname = current_database() and l.locktype = 'advisory' and not l.granted`,
      );
      expect(row?.n).toBe(1);
    },
    { timeout: 5000, interval: 50 },
  );
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('security alert log pruning', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'alertlogclock' });
    login = await loginIn(db, 'ops_astro_forwarder', 'fwclock');
    forwarderDb = connectAsAdmin(login.url, { source: 'forwarder' });
  }, 180_000);

  afterAll(async () => {
    await forwarderDb?.close();
    await db?.drop();
    const cleanup = new Client(databaseUrlFromEnvironment() ?? '');
    try {
      if (login !== undefined) await cleanup.query(`drop role "${login.name}"`);
    } finally {
      await cleanup.end();
    }
  });

  it('a pass that waited on the forwarder lock deletes a row that crossed ninety days meanwhile', async () => {
    await db.admin.execute('truncate ops.api_events, ops.api_alerts, ops.security_alert_log');
    // Two seconds short of ninety days when the pass begins.
    await db.admin.execute(
      `insert into ops.security_alert_log (kind, at)
       values ('retention-clock', clock_timestamp() - interval '90 days' + interval '2 seconds')`,
    );
    const lock = await holdForwarderLock();
    const pass = createForwarder({
      database: forwarderDb,
      send: () => Promise.resolve(),
      where: 'staging',
      root: resolve(import.meta.dirname, '../..'),
    }).once();
    await passWaits();
    // The row is past ninety days by the time the pass deletes.
    await delay(4000);
    await lock.release();
    await pass;
    const left = await db.admin.execute<{ n: number }>(
      `select count(*)::int as n from ops.security_alert_log where kind = 'retention-clock'`,
    );
    expect(left).toEqual([{ n: 0 }]);
  }, 30_000);
});
