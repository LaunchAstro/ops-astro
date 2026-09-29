// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3c and S0-3d: the backup store's `S0-3 restore staleness` and
// `S0-3 backup encryption` (the store's half).
//
// S0-3 (S0-3c, line C8; S0-3d). The shared fixture is backup-identity.fixture.ts.

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  job,
  serverUrl,
  BACKUP,
  RETENTION,
  RESTORE,
  keys,
  drill,
  seal,
  asRole,
  attempt,
  store,
  backupLogin,
  retentionLogin,
  restoreLogin,
  receipts,
  archiveIds,
  backupStoreHooks,
} from './backup-identity.fixture.ts';

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();

  theBackupStoreCases5();
  theBackupStoreCases6();
});

const address = 'https://heartbeat.example.test/api/push/restore';

const expire = async (sent: string[]) =>
  await (
    await job()
  ).expireBackups({
    storeUrl: retentionLogin.url,
    restoreHeartbeat: address,
    send: (to: string | undefined) => {
      sent.push(to ?? '');
      return Promise.resolve('sent');
    },
  });

const age = async (days: number) => {
  await store.admin.execute('alter table backups.drills disable trigger drills_append_only');
  try {
    await store.admin.execute(
      `update backups.drills set at = now() - make_interval(days => ${days})`,
    );
  } finally {
    await store.admin.execute('alter table backups.drills enable trigger drills_append_only');
  }
};

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
      publicKey: keys.publicKey,
      heartbeat: beat,
      send,
    });
    expect(bad).toMatchObject({ outcome: 'failed' });
    expect(sent).toStrictEqual([beat]);
  });
}

function theBackupStoreCases6() {
  describe('S0-3 backup encryption', () => {
    backupEncryptionCases1();
    backupEncryptionCases2();
    backupEncryptionCases3();
  });
}

function backupEncryptionCases1() {
  it('a read stays logged after the reader rolls back', async () => {
    const { runBackup } = await job();
    const recorded = await runBackup({
      dump: async () => Buffer.from('PGDMP rollback proof'),
      storeUrl: backupLogin.url,
      publicKey: keys.publicKey,
    });
    expect(recorded['outcome']).toBe('recorded');
    const before = (await receipts()).length;
    const reader = postgres(restoreLogin.url, { max: 1 });
    try {
      await expect(
        reader.begin(async (tx) => {
          await tx.unsafe(`set local role ${RESTORE}`);
          const [archive] = await tx`select body from backups.read_latest()`;
          expect(archive?.['body']).toBeInstanceOf(Buffer);
          throw new Error('rollback after access');
        }),
      ).rejects.toThrow('rollback after access');
    } finally {
      await reader.end();
    }
    expect((await receipts()).length).toBe(before + 1);
  });
}

function backupEncryptionCases2() {
  it('stores only the sealed artefact, and refuses to store a backup it cannot seal', async () => {
    const { runBackup } = await job();
    const dump = Buffer.from(`PGDMP made-up ${randomBytes(6).toString('hex')}`);
    const ok = await runBackup({
      dump: async () => dump,
      storeUrl: backupLogin.url,
      publicKey: keys.publicKey,
    });
    expect(ok).toMatchObject({ outcome: 'recorded' });
    const [row] = await store.admin.execute<{ body: Buffer }>(
      'select body from backups.archives order by taken_at desc, id desc limit 1',
    );
    expect(row?.body.includes(dump)).toBe(false);
    expect(row?.body.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(
      (await seal()).openArchive(row?.body ?? Buffer.alloc(0), keys.privateKey).equals(dump),
    ).toBe(true);

    const before = await archiveIds();
    const unsealed = await runBackup({ dump: async () => dump, storeUrl: backupLogin.url });
    expect(unsealed).toMatchObject({ outcome: 'failed', stage: 'seal' });
    expect(await archiveIds()).toStrictEqual(before);
  });
}

function backupEncryptionCases3() {
  it('lets the restore identity read the newest backup only through the store, logging each read', async () => {
    const [newest] = await store.admin.execute<{ id: string; taken_at: Date }>(
      'select id::text, taken_at from backups.archives order by taken_at desc, id desc limit 1',
    );
    const before = (await receipts()).length;
    const { fetchLatest } = await drill();
    const fetched = await fetchLatest(restoreLogin.url);
    expect(fetched.takenAt).toBe(newest?.taken_at.toISOString());
    const logged = await receipts();
    expect(logged.length).toBe(before + 1);
    expect(logged.at(-1)).toMatchObject({ action: 'backup read', archive_id: newest?.id });
    const [actor] = await store.admin.execute<{ actor: string }>(
      'select actor from backups.receipts order by id desc limit 1',
    );
    expect(actor?.actor).toBe(restoreLogin.name);

    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      for (const text of [
        'select body from backups.archives',
        'select id from backups.archives',
        `insert into backups.archives (body) values ('\\x01')`,
        'delete from backups.archives',
        'update backups.receipts set actor = actor',
        'select * from backups.settings',
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(reader, text), text).toBe('42501');
      }
    } finally {
      await reader.end();
    }
    for (const [login, role] of [
      [backupLogin, BACKUP],
      [retentionLogin, RETENTION],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const other = await asRole(login.url, role);
      try {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(other, 'select * from backups.read_latest()')).toBe('42501');
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await other.end();
      }
    }
    expect((await receipts()).length).toBe(before + 1);
  });
}
