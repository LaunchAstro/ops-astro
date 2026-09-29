// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3 (REV158S2 criteria 12 and 13): Sol's proofs, named by what they prove.
// Every part the store hands out leaves a receipt; a read of one archive never
// attests another taken in the same transaction, at the same time.

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RESTORE,
  asRole,
  attempt,
  backupLogin,
  restoreLogin,
  backupStoreHooks,
  store,
} from './backup-identity.fixture.ts';

const countReadReceipts = async (): Promise<number> => {
  const [row] = await store.admin.execute<{ n: number }>(
    "select count(*)::int as n from backups.receipts where action = 'backup read'",
  );
  return row?.n ?? 0;
};

describe.skipIf(serverUrl === undefined)('S0-3 store read binding', () => {
  backupStoreHooks();

  readBindingCases1();

  readBindingCases2();
});

function readBindingCases1() {
  it('every successful read_part access writes an access receipt', async () => {
    const writer = await asRole(backupLogin.url, BACKUP);
    try {
      await writer.query('begin');
      await writer.query("select backups.add_part(0, '\\x01')");
      await writer.query("select backups.complete_archive(1, repeat('a', 64))");
      await writer.query('commit');
    } finally {
      await writer.end();
    }
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ id: string }>('select id from backups.read_latest()');
      const id = rows[0]?.id;
      expect(id).toBeDefined();
      const before = await countReadReceipts();
      await reader.query('select * from backups.read_part($1, 0)', [id]);
      await reader.query('select * from backups.read_part($1, 0)', [id]);
      expect(await countReadReceipts()).toBe(before + 2);
    } finally {
      await reader.end();
    }
  });
}

function readBindingCases2() {
  it('a read of one same-time archive cannot attest a different archive', async () => {
    const firstDigest = createHash('sha256')
      .update(Buffer.from([1]))
      .digest('hex');
    const secondDigest = createHash('sha256')
      .update(Buffer.from([2]))
      .digest('hex');
    const writer = await asRole(backupLogin.url, BACKUP);
    try {
      await writer.query('begin');
      await writer.query("select backups.add_part(0, '\\x01')");
      await writer.query('select backups.complete_archive(1, $1)', [firstDigest]);
      await writer.query("select backups.add_part(0, '\\x02')");
      await writer.query('select backups.complete_archive(1, $1)', [secondDigest]);
      await writer.query('commit');
    } finally {
      await writer.end();
    }
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ taken_at: Date; sha256: string }>(
        'select taken_at, sha256 from backups.read_latest()',
      );
      const latest = rows[0];
      expect(latest).toBeDefined();
      const otherDigest = latest?.sha256 === firstDigest ? secondDigest : firstDigest;
      const code = await attempt(
        reader,
        'select backups.record_carried_drill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        ['passed', null, randomUUID(), latest?.taken_at, 17, 17, 17, 1, { fetch: 1 }, otherDigest],
      );
      expect(code).toBe('42501');
    } finally {
      await reader.end();
    }
  });
}
