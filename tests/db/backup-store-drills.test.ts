// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3d: the backup store's `S0-3 drill receipt`, then `S0-3 restore staleness`,
// which reads the passed drill the receipt cases record, so the two share a
// store and run in that order. A pass is recorded through the appointed
// operator's own store login, for an archive it read (S0-3e,
// backup-carried-attest.test.ts has why); a failed drill through the restore
// identity alone.
//
// S0-3 (S0-3d). The shared fixture is backup-identity.fixture.ts.

import { describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RETENTION,
  RESTORE,
  keys,
  asRole,
  attempt,
  store,
  backupLogin,
  retentionLogin,
  restoreLogin,
  operatorLogin,
  backupStoreHooks,
  hostReach,
  type Reach,
  address,
  expire,
  age,
  job,
} from './backup-identity.fixture.ts';
import { operator, passed, failed, call } from './backup-drill-records.fixture.ts';
import { operatorReceiptCase, readNew } from './backup-store-drills.fixture.ts';

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();

  theBackupStoreCases4();
  theBackupStoreCases5();
});

function theBackupStoreCases4() {
  describe('S0-3 drill receipt', () => {
    drillReceiptCases1();
    drillReceiptCases2();
    drillReceiptCases3();
    drillReceiptCases4();
  });
}

function drillReceiptCases1() {
  it('a failed drill before any passed one is recorded, and names no last tested restore', async () => {
    const path = '../../scripts/ops/restore-drill.mjs';
    const { recordDrill } = (await import(
      /* @vite-ignore */
      path
    )) as {
      recordDrill: (
        url: string,
        who: string,
        r: Record<string, unknown>,
        reach: Reach,
      ) => Promise<unknown>;
    };
    expect(await recordDrill(restoreLogin.url, operator, failed, hostReach)).toBeNull();
    const [row] = await store.admin.execute<{ n: number }>(
      `select count(*)::int as n from backups.drills where outcome = 'failed'`,
    );
    expect(row?.n).toBe(1);
  });
}

/* eslint-disable max-lines-per-function -- one test, its body kept byte for byte */
function drillReceiptCases2() {
  it('only the restore identity records a drill, and a receipt is never changed or removed', async () => {
    for (const [login, role] of [
      [backupLogin, BACKUP],
      [retentionLogin, RETENTION],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const client = await asRole(login.url, role);
      try {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(client, ...call(passed)), role).toBe('42501');
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await client.end();
      }
    }
    // The restore identity alone cannot pass at all (read-binding suite);
    // the appointed operator's login is refused everything else here too.
    const reader = await asRole(operatorLogin.url, RESTORE);
    try {
      const bound = await readNew(reader);
      for (const text of [
        'select * from backups.drills',
        'update backups.drills set outcome = outcome',
        'delete from backups.drills',
        `insert into backups.drills (outcome, operator, production_major, timings) values ('passed', gen_random_uuid(), 17, '{}')`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(reader, text), text).toBe('42501');
      }
      // A passed drill with a field missing is not a passed drill.
      const [text, values] = call(passed, bound);
      expect(await attempt(reader, text, values)).toBe('ok');
      expect(await attempt(reader, text, values.with(5, null))).toBe('23514');
      expect(await attempt(reader, text, values.with(4, 18))).toBe('23514');
      // Timings are stage names and milliseconds, and nothing else. Each is
      // sent as the drill sends it (`sql.json`), so none is a jsonb string
      // refused for its type alone; the last is that string.
      for (const timings of [
        { fetch: 'made-up record text' },
        { note: 4 },
        [1, 2],
        { open: { x: 1 } },
        'made-up record text',
      ]) {
        const label = JSON.stringify(timings);
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(reader, text, values.with(8, timings)), label).toBe('23514');
      }
    } finally {
      await reader.end();
    }
    for (const text of [
      'update backups.drills set outcome = outcome',
      'delete from backups.drills',
      'truncate backups.drills',
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(store.admin.execute(text), text).rejects.toThrow(/append-only/u);
    }
  });
}
/* eslint-enable max-lines-per-function */

function drillReceiptCases3() {
  it('a passed drill answers its own date as the last tested restore; a failed one answers the last passed', async () => {
    const reader = await asRole(operatorLogin.url, RESTORE);
    try {
      const first = await reader.query<{ last: string }>(...call(passed, await readNew(reader)));
      const last = first.rows[0]?.last ?? '';
      expect(Date.parse(last)).toBeGreaterThan(Date.now() - 60_000);
      const second = await reader.query<{ last: string }>(...call(failed));
      expect(second.rows[0]?.last).toBe(last);
    } finally {
      await reader.end();
    }
    const rows = await store.admin.execute<{
      outcome: string;
      stage: string | null;
      actor: string;
    }>('select outcome, stage, actor from backups.drills order by id');
    expect(rows.slice(-2)).toStrictEqual([
      { outcome: 'passed', stage: null, actor: operatorLogin.name },
      { outcome: 'failed', stage: 'restore', actor: operatorLogin.name },
    ]);
  });
}

function drillReceiptCases4() {
  it('the operator receipt has every field and no other, and carries no key, credential, path or record data', async () => {
    await operatorReceiptCase();
  });
}

function theBackupStoreCases5() {
  describe('S0-3 restore staleness', () => {
    restoreStalenessCases1();
    restoreStalenessCases2();
  });
}

function restoreStalenessCases1() {
  it('the daily upkeep pings the restore heartbeat only while a drill passed inside the window', async () => {
    const [settings] = await store.admin.execute<{ days: number }>(
      'select restore_days as days from backups.settings',
    );
    const window = settings?.days ?? 0;
    expect(window).toBeGreaterThan(0);

    await age(window - 1);
    const fresh: string[] = [];
    expect(await expire(fresh)).toMatchObject({ restoreFresh: true, restoreHeartbeat: 'sent' });
    expect(fresh).toStrictEqual([address]);

    await age(window + 1);
    const stale: string[] = [];
    expect(await expire(stale)).toMatchObject({
      restoreFresh: false,
      restoreHeartbeat: 'withheld',
    });
    expect(stale).toStrictEqual([]);
  });

  it('the retention identity learns only yes or no, and cannot record or read a drill', async () => {
    const client = await asRole(retentionLogin.url, RETENTION);
    try {
      const answer = await client.query('select backups.restore_fresh() as fresh');
      expect(Object.keys(answer.rows[0] ?? {})).toStrictEqual(['fresh']);
      expect(typeof answer.rows[0]?.['fresh']).toBe('boolean');
      expect(await attempt(client, 'select * from backups.drills')).toBe('42501');
    } finally {
      await client.end();
    }
    const backup = await asRole(backupLogin.url, BACKUP);
    try {
      expect(await attempt(backup, 'select backups.restore_fresh()')).toBe('42501');
    } finally {
      await backup.end();
    }
  });
}

function restoreStalenessCases2() {
  it('a recorded backup pings the backup heartbeat; a failed one does not', async () => {
    const sent: string[] = [];
    const send = async (to: string | undefined) => {
      sent.push(to ?? '');
      return 'sent';
    };
    const { runBackup } = await job();
    const beat = 'https://heartbeat.example.test/api/push/backup';
    const ok = await runBackup({
      dump: async () => Buffer.from('PGDMP made-up nightly'),
      storeUrl: backupLogin.url,
      reach: hostReach,
      publicKey: keys.publicKey,
      heartbeat: beat,
      send,
    });
    expect(ok).toMatchObject({ outcome: 'recorded', heartbeat: 'sent' });
    const bad = await runBackup({
      dump: async () => {
        throw new Error('no');
      },
      storeUrl: backupLogin.url,
      reach: hostReach,
      publicKey: keys.publicKey,
      heartbeat: beat,
      send,
    });
    expect(bad).toMatchObject({ outcome: 'failed' });
    expect(sent).toStrictEqual([beat]);
  });
}
