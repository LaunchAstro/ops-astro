// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  APPLICATION_ROLE,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an indirect application login holds TEMPORARY before this guard and loses it after',
  async () => {
    const db = await createEmptyDatabase({ part: 'indirecttempup' });
    const middle = `${db.name}_middle`;
    const login = `${db.name}_indirect`;
    try {
      const migrations = readMigrations('migrations');
      await applyMigrations(
        db.admin,
        migrations.filter((m) => m.version.slice(0, 4) <= '0028'),
      );
      await db.admin.execute(`create role "${middle}" nologin in role ${APPLICATION_ROLE}`);
      await db.admin.execute(`create role "${login}" login in role "${middle}"`);
      await db.admin.execute(`grant temporary on database "${db.name}" to "${middle}", "${login}"`);
      await applyMigrations(
        db.admin,
        migrations.filter((m) => m.version.slice(0, 4) > '0028' && m.version < '20261012052116'),
      );
      const held = async () =>
        await db.admin.execute<{ login: boolean; middle: boolean }>(
          `select has_database_privilege($1, current_database(), 'TEMPORARY') as login,
              has_database_privilege($2, current_database(), 'TEMPORARY') as middle`,
          [login, middle],
        );
      expect((await held())[0]).toStrictEqual({ login: true, middle: false });
      await applyMigrations(
        db.admin,
        migrations.filter((m) => m.version.startsWith('20261012052116_')),
      );
      expect((await held())[0]).toStrictEqual({ login: false, middle: false });
    } finally {
      await db.drop();
      const server = connectAsAdmin(databaseUrlFromEnvironment() ?? '');
      try {
        await server.execute(`drop role if exists "${login}"`);
        await server.execute(`drop role if exists "${middle}"`);
      } finally {
        await server.close();
      }
    }
  },
  180_000,
);
