// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  BACKUP,
  RESTORE,
  OPERATING_BUSINESS,
  addArchive,
  asRole,
  attempt,
  backupLogin,
  backupStoreHooks,
  operatorLogin,
  store,
} from '../db/backup-identity.fixture.ts';
import { operator } from '../db/backup-drill-records.fixture.ts';

describe('OW-059 frozen-head proofs', () => {
  backupStoreHooks();

  it('Sol proof, criterion 3: revoking an operator appointment revokes access to archive parts', async () => {
    const writer = await asRole(backupLogin.url, BACKUP);
    const reader = await asRole(operatorLogin.url, RESTORE);
    try {
      await addArchive(writer, Buffer.from('sealed archive bytes'), false);
      const { rows } = await reader.query<{ id: string }>(
        'select id from backups.read_latest($1, $2)',
        [operator, OPERATING_BUSINESS],
      );
      const id = rows[0]?.id;
      expect(id).toBeDefined();
      const initial = await reader.query('select * from backups.read_part($1, 0)', [id]);
      expect(initial.rowCount).toBe(1);

      await store.admin.execute('delete from backups.appointed where login = $1', [
        operatorLogin.name,
      ]);
      expect(
        await attempt(reader, 'select id from backups.read_latest($1, $2)', [
          operator,
          OPERATING_BUSINESS,
        ]),
      ).toBe('42501');
      // A fresh connection also has the historical receipt. This is not an
      // in-flight request or an old transaction retaining its snapshot.
      const reconnect = await asRole(operatorLogin.url, RESTORE);
      try {
        let code = 'ok';
        let partsReturned = 0;
        try {
          const result = await reconnect.query('select * from backups.read_part($1, 0)', [id]);
          partsReturned = result.rowCount;
        } catch (error) {
          code =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'unknown';
        }
        expect({ code, partsReturned }).toEqual({ code: '42501', partsReturned: 0 });
      } finally {
        await reconnect.end();
      }
    } finally {
      await store.admin.execute('insert into backups.appointed (login, person) values ($1, $2)', [
        operatorLogin.name,
        operator,
      ]);
      await reader.end();
      await writer.end();
    }
  });
});
