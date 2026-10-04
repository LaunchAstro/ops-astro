// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  RESTORE,
  OPERATING_BUSINESS,
  asRole,
  attempt,
  backupLogin,
  backupStoreHooks,
  hostReach,
  job,
  keys,
  operatorLogin,
  store,
} from '../db/backup-identity.fixture.ts';
import { operator } from '../db/backup-drill-records.fixture.ts';

describe('OW-062 restore read revocation on the real store', () => {
  backupStoreHooks();

  it('revoking an appointed operator blocks subsequent archive part reads', async () => {
    const added = await (
      await job()
    ).runBackup({
      dump: async () => Buffer.from('PGDMP synthetic cross-business backup'),
      storeUrl: backupLogin.url,
      publicKey: keys.publicKey,
      reach: hostReach,
      send: async () => 'sent',
    });
    expect(added['outcome']).toBe('recorded');
    const reader = await asRole(operatorLogin.url, RESTORE);
    try {
      const header = await reader.query<{ id: string }>(
        'select id from backups.read_latest($1, $2)',
        [operator, OPERATING_BUSINESS],
      );
      const archiveId = header.rows[0]?.id;
      expect(archiveId).toBeDefined();
      const control = await reader.query('select part from backups.read_part($1, 0)', [archiveId]);
      expect(
        control.rowCount,
        'the appointed operator can read this archive before revocation',
      ).toBe(1);
      await store.admin.execute('delete from backups.appointed where login = $1', [
        operatorLogin.name,
      ]);
      expect(
        await attempt(reader, 'select id from backups.read_latest($1, $2)', [
          operator,
          OPERATING_BUSINESS,
        ]),
        'revocation is committed and already blocks header reads',
      ).toBe('42501');
      expect(
        await attempt(reader, 'select part from backups.read_part($1, 0)', [archiveId]),
        'a historic read receipt must not preserve access for a revoked operator',
      ).toBe('42501');
    } finally {
      await reader.end();
    }
  });
});
