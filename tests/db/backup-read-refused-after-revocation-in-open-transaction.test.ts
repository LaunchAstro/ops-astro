// SPDX-License-Identifier: AGPL-3.0-only
//
// An appointment removed ends the operator's reads, even in a transaction
// that began before the removal committed. A repeatable-read transaction
// keeps the snapshot it took first, so an appointment read through it would
// still be there after it was deleted. The store reads it as it stands now
// (deploy/staging/backup-store-upgrade-2.sql).

import { describe, expect, it } from 'vitest';
import {
  BACKUP,
  RESTORE,
  OPERATING_BUSINESS,
  addArchive,
  asRole,
  backupLogin,
  backupStoreHooks,
  operatorLogin,
  serverUrl,
  store,
  type Client,
} from './backup-identity.fixture.ts';
import { operator } from './backup-drill-records.fixture.ts';

/** The SQLSTATE and row count of `text` inside the reader's open transaction. */
async function inOpenTransaction(
  reader: Client,
  text: string,
  values: unknown[],
): Promise<{ code: string; rows: number }> {
  try {
    const { rowCount } = await reader.query(text, values);
    return { code: 'ok', rows: rowCount };
  } catch (error) {
    return { code: (error as { code?: string }).code ?? 'unknown', rows: 0 };
  }
}

describe.skipIf(serverUrl === undefined)(
  'a revoked operator reads nothing in an old snapshot',
  () => {
    backupStoreHooks();

    it.each([
      ['an archive part', 'select * from backups.read_part($1, 0)', (id: string) => [id]],
      [
        "the newest archive's header",
        'select id from backups.read_latest($1, $2)',
        () => [operator, OPERATING_BUSINESS],
      ],
    ])('%s is refused once the removal commits', async (_what, text, values) => {
      const writer = await asRole(backupLogin.url, BACKUP);
      const reader = await asRole(operatorLogin.url, RESTORE);
      try {
        await addArchive(writer, Buffer.from('sealed archive bytes'), false);
        const { rows } = await reader.query<{ id: string }>(
          'select id from backups.read_latest($1, $2)',
          [operator, OPERATING_BUSINESS],
        );
        const id = rows[0]?.id ?? '';
        await reader.query('begin isolation level repeatable read');
        // The transaction's snapshot is taken here, before the removal commits.
        await reader.query('select 1');
        await store.admin.execute('delete from backups.appointed where login = $1', [
          operatorLogin.name,
        ]);
        expect(await inOpenTransaction(reader, text, values(id))).toEqual({
          code: '42501',
          rows: 0,
        });
      } finally {
        await reader.query('rollback');
        await store.admin.execute(
          'insert into backups.appointed (login, person) values ($1, $2) on conflict do nothing',
          [operatorLogin.name, operator],
        );
        await reader.end();
        await writer.end();
      }
    });
  },
);
