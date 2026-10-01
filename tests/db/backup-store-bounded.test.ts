// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-3 store bounded` (ticket S0-3, lines C1 and C11; ORCH25-SL01-STORE). The
// backup store is the one persistent place staging has (S0-1's disk row names
// its volume as the only exception), so the store bounds itself: the cap is
// `backups.settings.max_bytes`, and an archive that would take the stored total
// past it is refused by the server, whatever the job does. The total is one
// row the insert takes a lock on, so two archives written at once are judged
// one after the other. The shared fixture is backup-identity.fixture.ts.

import { describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RETENTION,
  RESTORE,
  read,
  asRole,
  attempt,
  store,
  backupLogin,
  retentionLogin,
  restoreLogin,
  receipts,
  archiveIds,
  addArchive,
  backupStoreHooks,
  type Client,
} from './backup-identity.fixture.ts';

const FULL = '53400';

/** Bytes already stored, as the admin counts them from the archives themselves. */
async function stored(): Promise<number> {
  const [row] = await store.admin.execute<{ n: string }>(
    'select coalesce(sum(bytes), 0)::text as n from backups.archives',
  );
  return Number(row?.n);
}

/** Sets the cap `room` bytes above what is stored now. */
async function roomFor(room: number): Promise<void> {
  await store.admin.execute(`update backups.settings set max_bytes = ${(await stored()) + room}`);
}

/** An archive of `bytes` bytes, as the job adds one; `open` when the caller holds a transaction. */
const add = (client: Client, bytes: number, open = false) =>
  addArchive(client, Buffer.alloc(bytes, 7), open);

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

/** Resolves once `pid` is waiting on a lock, so the pair's order is fixed, not timed. */
async function waitingOnLock(pid: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const [row] = await store.admin.execute<{ waiting: boolean }>(
      `select coalesce(bool_or(wait_event_type = 'Lock'), false) as waiting
         from pg_stat_activity where pid = ${pid}`,
    );
    if (row?.waiting === true) return;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  return Number(rows[0]?.pid);
}

describe.skipIf(serverUrl === undefined)('S0-3 store bounded', () => {
  backupStoreHooks();

  boundedCases1();
  boundedCases2();
  boundedCases3();
  boundedCases4();
});

function boundedCases1() {
  it('holds the cap in the store, where no job identity can change it', async () => {
    const [row] = await store.admin.execute<{ n: number; cap: string }>(
      'select count(*)::int as n, min(max_bytes)::text as cap from backups.settings',
    );
    expect(row?.n).toBe(1);
    expect(Number(row?.cap)).toBeGreaterThan(0);
    for (const [login, role] of [
      [backupLogin, BACKUP],
      [retentionLogin, RETENTION],
      [restoreLogin, RESTORE],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const client = await asRole(login.url, role);
      try {
        const refused = {
          // oxlint-disable-next-line no-await-in-loop
          cap: await attempt(client, 'update backups.settings set max_bytes = max_bytes * 2'),
          // oxlint-disable-next-line no-await-in-loop
          total: await attempt(client, 'update backups.stored set bytes = 0'),
          // oxlint-disable-next-line no-await-in-loop
          read: await attempt(client, 'select bytes from backups.stored'),
        };
        expect(refused, role).toStrictEqual({ cap: '42501', total: '42501', read: '42501' });
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await client.end();
      }
    }
    expect(read('scripts/ops/backup.mjs')).not.toMatch(/max_bytes/u);
  });

  it('takes an archive that fills the store exactly, and refuses one byte more, writing nothing', async () => {
    await roomFor(100);
    const client = await asRole(backupLogin.url, BACKUP);
    try {
      expect(await codeOf(add(client, 100))).toBe('ok');
      const [ids, seen] = [await archiveIds(), (await receipts()).length];
      expect(await codeOf(add(client, 1))).toBe(FULL);
      expect(await archiveIds()).toStrictEqual(ids);
      expect((await receipts()).length).toBe(seen);
    } finally {
      await client.end();
    }
  });
}

function boundedCases2() {
  it('of two archives that each fit alone but not together, written at once, one is recorded and one refused', async () => {
    await roomFor(150);
    const cap = (await stored()) + 150;
    const [first, second] = [
      await asRole(backupLogin.url, BACKUP),
      await asRole(backupLogin.url, BACKUP),
    ];
    try {
      await first.query('begin');
      await second.query('begin');
      await add(first, 100, true);
      const waiter = await backendPid(second);
      const later = codeOf(add(second, 100, true));
      await waitingOnLock(waiter);
      await first.query('commit');
      expect(await later).toBe(FULL);
      await second.query('rollback');
      expect(await stored()).toBeLessThanOrEqual(cap);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('a pair whose second holds an older snapshot (repeatable read) is refused too, never both recorded', async () => {
    await roomFor(150);
    const cap = (await stored()) + 150;
    const [first, second] = [
      await asRole(backupLogin.url, BACKUP),
      await asRole(backupLogin.url, BACKUP),
    ];
    try {
      await second.query('begin isolation level repeatable read');
      await second.query('select 1');
      await first.query('begin');
      await add(first, 100, true);
      const waiter = await backendPid(second);
      const later = codeOf(add(second, 100, true));
      await waitingOnLock(waiter);
      await first.query('commit');
      expect(await later).not.toBe('ok');
      await second.query('rollback');
      expect(await stored()).toBeLessThanOrEqual(cap);
    } finally {
      await first.end();
      await second.end();
    }
  });
}

function boundedCases3() {
  it('when the first of the pair is lost before it commits, the second is recorded', async () => {
    await roomFor(150);
    const [first, second] = [
      await asRole(backupLogin.url, BACKUP),
      await asRole(backupLogin.url, BACKUP),
    ];
    try {
      await first.query('begin');
      await second.query('begin');
      await add(first, 100, true);
      const waiter = await backendPid(second);
      const later = codeOf(add(second, 100, true));
      await waitingOnLock(waiter);
      await first.query('rollback');
      expect(await later).toBe('ok');
      await second.query('commit');
      // The lost archive's bytes were never counted: 50 remain, not 51.
      expect(await codeOf(add(first, 51))).toBe(FULL);
      expect(await codeOf(add(first, 50))).toBe('ok');
    } finally {
      await first.end();
      await second.end();
    }
  });
}

function boundedCases4() {
  it('an expired backup gives its room back, and a lowered cap refuses every new archive but deletes nothing', async () => {
    await roomFor(100);
    const client = await asRole(backupLogin.url, BACKUP);
    try {
      expect(await codeOf(add(client, 100))).toBe('ok');
      expect(await codeOf(add(client, 100))).toBe(FULL);
      await store.admin.execute(
        `update backups.archives set taken_at = now() - make_interval(days => (select retention_days + 1 from backups.settings))`,
      );
      const retention = await asRole(retentionLogin.url, RETENTION);
      try {
        await retention.query('delete from backups.archives');
      } finally {
        await retention.end();
      }
      expect(await archiveIds()).toStrictEqual([]);
      expect(await codeOf(add(client, 100))).toBe('ok');

      await store.admin.execute('update backups.settings set max_bytes = 1');
      const kept = await archiveIds();
      expect(await codeOf(add(client, 1))).toBe(FULL);
      expect(await archiveIds()).toStrictEqual(kept);
    } finally {
      await client.end();
    }
  });
}
