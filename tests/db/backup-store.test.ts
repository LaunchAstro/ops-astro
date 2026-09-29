// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3b: the backup store. `S0-3 identity scope` on the store,
// `S0-3 backup scheduled` and `S0-3 backup retention`.
//
// S0-3 (lines C1 and C11). The shared fixture is backup-identity.fixture.ts.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  job,
  serverUrl,
  BACKUP,
  RETENTION,
  keys,
  read,
  asRole,
  attempt,
  store,
  backupLogin,
  retentionLogin,
  receipts,
  archiveIds,
  backupStoreHooks,
} from './backup-identity.fixture.ts';

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();

  theBackupStoreCases1();
  theBackupStoreCases2();
  theBackupStoreCases3();
});

function theBackupStoreCases1() {
  describe('S0-3 identity scope', () => {
    it('adds a backup and is refused every list, read, change or delete on the store', async () => {
      const client = await asRole(backupLogin.url, BACKUP);
      try {
        await client.query('insert into backups.archives (body) values ($1)', [
          Buffer.from('PGDMP made-up'),
        ]);
        const refused: Record<string, string> = {};
        for (const [what, text] of Object.entries({
          list: 'select id, taken_at from backups.archives',
          read: 'select body from backups.archives',
          count: 'select count(*) from backups.archives',
          returning: `insert into backups.archives (body) values ('\\x00') returning id`,
          backdate: `insert into backups.archives (body, taken_at) values ('\\x00', now() - interval '400 days')`,
          change: `update backups.archives set body = '\\x00'`,
          delete: 'delete from backups.archives',
          truncate: 'truncate backups.archives',
          receipts: 'select * from backups.receipts',
          forge: `insert into backups.receipts (action) values ('backup expired')`,
          window: 'update backups.settings set retention_days = 1',
        })) {
          // oxlint-disable-next-line no-await-in-loop
          refused[what] = await attempt(client, text);
        }
        expect(Object.values(refused).every((code) => code === '42501')).toBe(true);
      } finally {
        await client.end();
      }
      const [row] = await store.admin.execute<{ n: number; sha: string }>(
        `select count(*)::int as n, min(sha256) as sha from backups.archives`,
      );
      expect(row?.n).toBe(1);
      expect(row?.sha).toMatch(/^[0-9a-f]{64}$/u);
    });
  });
}

function theBackupStoreCases2() {
  describe('S0-3 backup scheduled', () => {
    backupScheduledCases1();
    backupScheduledCases2();
  });
}

function backupScheduledCases1() {
  it('records every run: a recorded backup leaves a receipt, a failed one says only that it failed', async () => {
    const before = (await receipts()).length;
    const { runBackup } = await job();
    const ok = await runBackup({
      dump: async () => Buffer.from('PGDMP made-up nightly'),
      storeUrl: backupLogin.url,
      publicKey: keys.publicKey,
    });
    expect(ok).toMatchObject({ event: 'backup run', outcome: 'recorded' });
    const after = await receipts();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ action: 'backup recorded', bytes: String(ok['bytes']) });

    const canary = `canary-${randomBytes(8).toString('hex')}`;
    const failed = await runBackup({
      dump: async () => {
        throw new Error(`pg_dump: password ${canary} rejected for ${backupLogin.url}`);
      },
      storeUrl: backupLogin.url,
      publicKey: keys.publicKey,
    });
    expect(failed).toMatchObject({ event: 'backup run', outcome: 'failed', stage: 'dump' });
    expect(JSON.stringify(failed)).not.toContain(canary);
    expect(JSON.stringify(failed)).not.toContain(backupLogin.name);
    expect((await receipts()).length).toBe(before + 1);

    const refusedStore = await runBackup({
      dump: async () => Buffer.from('PGDMP'),
      storeUrl: retentionLogin.url,
      publicKey: keys.publicKey,
    });
    expect(refusedStore).toMatchObject({ outcome: 'failed', stage: 'store' });
    expect(JSON.stringify(refusedStore)).not.toContain(retentionLogin.name);
  });
}

function backupScheduledCases2() {
  it('is scheduled daily on staging, each job under its own identity, with no credential in the definition', () => {
    const jobs = {
      run: read('deploy/staging/ops-astro-staging-backup.plist'),
      expire: read('deploy/staging/ops-astro-staging-backup-expire.plist'),
    };
    const envFiles = new Set<string>();
    for (const [command, plist] of Object.entries(jobs)) {
      expect(plist).toMatch(/<key>Label<\/key>\s*<string>ops-astro-staging-backup/u);
      expect(plist).toMatch(
        /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>\d+<\/integer>/u,
      );
      expect(plist).toContain('<string>scripts/ops/backup.mjs</string>');
      expect(plist).toContain(`<string>${command}</string>`);
      const env = /--env-file=([^<]+)</u.exec(plist)?.[1];
      expect(env).toBeDefined();
      envFiles.add(env ?? '');
      expect(plist).not.toMatch(/postgres(ql)?:\/\/|password|PGPASSWORD|\/Users\//iu);
    }
    expect(envFiles.size).toBe(2);
  });
}

function theBackupStoreCases3() {
  describe('S0-3 backup retention', () => {
    backupRetentionCases1();
    backupRetentionCases2();
  });
}

function backupRetentionCases1() {
  it('keeps the window in one place, the store', async () => {
    const [row] = await store.admin.execute<{ n: number; days: number }>(
      'select count(*)::int as n, min(retention_days) as days from backups.settings',
    );
    expect(row?.n).toBe(1);
    expect(row?.days).toBeGreaterThan(0);
    expect(read('scripts/ops/backup.mjs')).not.toMatch(/retention_days\s*=|interval\s*'\d/u);
  });
}

function backupRetentionCases2() {
  // prettier-ignore
  it('deletes only a backup past the window, each with a receipt, and cannot delete one inside it', async () => {
      await store.admin.execute(`insert into backups.archives (body) values ('\\x01'), ('\\x02')`);
      const [old] = await store.admin.execute<{ id: string }>(
        `update backups.archives set taken_at = now() - make_interval(days => (select retention_days + 1 from backups.settings))
          where id = (select id from backups.archives where body = '\\x01') returning id::text`,
      );
      const inWindow = (await archiveIds()).filter((id) => id !== old?.id);

      const client = await asRole(retentionLogin.url, RETENTION);
      try {
        expect(await attempt(client, 'select body from backups.archives')).toBe('42501');
        expect(
          await attempt(
            client,
            `update backups.archives set taken_at = now() - interval '999 days'`,
          ),
        ).toBe('42501');
        expect(await attempt(client, `insert into backups.archives (body) values ('\\x03')`)).toBe(
          '42501',
        );
        expect(await attempt(client, 'update backups.settings set retention_days = 1')).toBe(
          '42501',
        );
        expect(await attempt(client, 'truncate backups.archives')).toBe('42501');
        expect(await attempt(client, 'delete from backups.receipts')).toBe('42501');
        await client.query('begin');
        const tried = await client.query(
          'delete from backups.archives where id = any($1::uuid[])',
          [inWindow],
        );
        await client.query('commit');
        expect(tried.rowCount).toBe(0);
      } finally {
        await client.end();
      }
      expect(await archiveIds()).toStrictEqual([...inWindow, old?.id].toSorted());

      const { expireBackups } = await job();
      const receipt = await expireBackups({ storeUrl: retentionLogin.url });
      expect(receipt).toMatchObject({ event: 'backup expired', outcome: 'recorded', count: 1 });
      expect(await archiveIds()).toStrictEqual(inWindow.toSorted());
      const expired = (await receipts()).filter((r) => r.action === 'backup expired');
      expect(expired.map((r) => r.archive_id)).toStrictEqual([old?.id]);
    });
}
