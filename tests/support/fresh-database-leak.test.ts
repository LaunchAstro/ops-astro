// SPDX-License-Identifier: AGPL-3.0-only
//
// A fresh database that fails to migrate is dropped before the error reaches
// the caller (issue #103, leak C). The caller holds no handle on a database
// whose creation threw, so its `afterAll` cannot drop it, and the shared
// Postgres had gathered about 1,460 `t1_*` databases by 29 September.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a fresh database whose migration fails', () => {
  it('is dropped, with its roles, before the error reaches the caller', async () => {
    const part = `leakc${randomBytes(4).toString('hex')}`;
    const migrations = mkdtempSync(join(tmpdir(), 'leakc-'));
    onTestFinished(() => rmSync(migrations, { recursive: true, force: true }));
    writeFileSync(join(migrations, '0001_broken.sql'), 'select from where;\n');

    await expect(createFreshDatabase({ part, migrationsDirectory: migrations })).rejects.toThrow();

    const server = connectAsAdmin(serverUrl as string);
    try {
      const left = await server.execute<{ readonly kind: string; readonly name: string }>(
        `select 'database' as kind, datname as name from pg_database where datname like $1
         union all select 'role', rolname from pg_roles where rolname like $1`,
        [`t1_${part}_%`],
      );
      // Whatever a failing run leaves is this test's own, and goes with it.
      for (const { kind, name } of left) {
        // eslint-disable-next-line no-await-in-loop -- a database before its roles
        await server.execute(
          kind === 'database' ? `drop database "${name}" with (force)` : `drop role "${name}"`,
        );
      }
      expect(left.map(({ name }) => name)).toStrictEqual([]);
    } finally {
      await server.close();
    }
  }, 60_000);
});
