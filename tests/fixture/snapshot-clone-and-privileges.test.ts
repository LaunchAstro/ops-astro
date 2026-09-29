// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, expect, it, vi } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

vi.mock('./generate.ts', () => ({
  seedFixture: () => ({ seedMs: 0, heldBack: [] }),
}));

const serverUrl = databaseUrlFromEnvironment();
const originalArgv = process.argv;

afterAll(() => {
  process.argv = originalArgv;
});

it.skipIf(serverUrl === undefined)(
  'building a snapshot completes and leaves a cloneable template',
  async () => {
    const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
    const databases = async () =>
      (
        await server.execute<{ datname: string }>(
          "select datname from pg_database where datname like 'fixture\\_%' or datname like 't1_fixture\\_%'",
        )
      ).map((row) => row.datname);
    const roles = async () =>
      (
        await server.execute<{ rolname: string }>(
          "select rolname from pg_roles where rolname like 't1_fixture_%'",
        )
      ).map((row) => row.rolname);
    const beforeDatabases = await databases();
    const beforeRoles = await roles();
    try {
      process.argv = ['node', 'tests/fixture/snapshot.ts', 'build'];
      await expect(import('./snapshot.ts')).resolves.toBeDefined();
      const template = (await databases()).find(
        (name) => name.startsWith('fixture_') && !beforeDatabases.includes(name),
      );
      expect(template).toBeDefined();
      const clone = `fixture_sol_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await server.execute(`create database "${clone}" template "${template}"`);
      expect(await databases()).toContain(clone);
    } finally {
      process.argv = originalArgv;
      await Promise.all(
        (await databases())
          .filter((item) => !beforeDatabases.includes(item))
          .map(async (name) => await server.execute(`drop database "${name}" with (force)`)),
      );
      await Promise.all(
        (await roles())
          .filter((item) => !beforeRoles.includes(item))
          .map(async (name) => await server.execute(`drop role "${name}"`)),
      );
      await server.close();
    }
  },
  120_000,
);

it.skipIf(serverUrl === undefined)(
  'clone works while a reader is connected to the template',
  async () => {
    const hash = createHash('sha256');
    const sources = [
      ...readdirSync('migrations')
        .filter((name) => name.endsWith('.sql'))
        .toSorted()
        .map((name) => `migrations/${name}`),
      ...['shape', 'cast', 'generate'].map((name) => `tests/fixture/${name}.ts`),
    ];
    for (const source of sources) hash.update(source).update(readFileSync(source));
    const template = `fixture_${hash.digest('hex').slice(0, 16)}`;
    const clone = `fixture_sol_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
    const existing = await server.execute<{ datname: string }>(
      'select datname from pg_database where datname = $1',
      [template],
    );
    const created = existing.length === 0;
    if (created) await server.execute(`create database "${template}"`);
    const templateUrl = new URL(serverUrl ?? '');
    templateUrl.pathname = `/${template}`;
    const reader = postgres(templateUrl.toString(), { max: 1, idle_timeout: 0 });
    try {
      await reader`select 1`;
      process.argv = ['node', 'tests/fixture/snapshot.ts', 'clone', clone];
      vi.resetModules();
      await expect(import('./snapshot.ts')).resolves.toBeDefined();
      const made = await server.execute<{ datname: string }>(
        'select datname from pg_database where datname = $1',
        [clone],
      );
      expect(made).toHaveLength(1);
    } finally {
      process.argv = originalArgv;
      await reader.end();
      await server.execute(`drop database if exists "${clone}" with (force)`);
      if (created) await server.execute(`drop database "${template}" with (force)`);
      await server.close();
    }
  },
  120_000,
);

it.skipIf(serverUrl === undefined)(
  'both fixture clone paths deny temporary tables to the application role',
  async () => {
    const hash = createHash('sha256');
    const sources = [
      ...readdirSync('migrations')
        .filter((name) => name.endsWith('.sql'))
        .toSorted()
        .map((name) => `migrations/${name}`),
      ...['shape', 'cast', 'generate'].map((name) => `tests/fixture/${name}.ts`),
    ];
    for (const source of sources) hash.update(source).update(readFileSync(source));
    const template = `fixture_${hash.digest('hex').slice(0, 16)}`;
    const direct = `fixture_sol_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const fallback = `fixture_sol_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
    const existing = await server.execute<{ datname: string }>(
      'select datname from pg_database where datname = $1',
      [template],
    );
    const created = existing.length === 0;
    if (created) {
      await server.execute(`create database "${template}"`);
      await server.execute(`revoke temporary on database "${template}" from public`);
    }
    const templateUrl = new URL(serverUrl ?? '');
    templateUrl.pathname = `/${template}`;
    const reader = postgres(templateUrl.toString(), { max: 1, idle_timeout: 0 });
    try {
      process.argv = ['node', 'tests/fixture/snapshot.ts', 'clone', direct];
      vi.resetModules();
      await import('./snapshot.ts');
      await reader`select 1`;
      process.argv = ['node', 'tests/fixture/snapshot.ts', 'clone', fallback];
      vi.resetModules();
      await import('./snapshot.ts');
      const rows = await server.execute<{ datname: string; temporary: boolean }>(
        `select datname, has_database_privilege('ops_astro_app', oid, 'TEMP') temporary
           from pg_database where datname in ($1, $2) order by datname`,
        [direct, fallback],
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.temporary)).toStrictEqual([false, false]);
    } finally {
      process.argv = originalArgv;
      await reader.end();
      await server.execute(`drop database if exists "${direct}" with (force)`);
      await server.execute(`drop database if exists "${fallback}" with (force)`);
      if (created) await server.execute(`drop database "${template}" with (force)`);
      await server.close();
    }
  },
  120_000,
);
