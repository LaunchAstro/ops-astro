// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, expect, it, vi } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

// What the build makes, as the seeding step sees it: the first case drops
// only these, never a fixture database another file made at the same time.
const built = vi.hoisted(() => ({ databases: [] as string[], roles: [] as string[] }));

vi.mock('./generate.ts', () => ({
  seedFixture: (db: { name: string; loginRole: string; restrictedRole: string }) => {
    built.databases.push(db.name);
    built.roles.push(db.loginRole, db.restrictedRole);
    return { seedMs: 0, heldBack: [] };
  },
}));

const serverUrl = databaseUrlFromEnvironment();
const originalArgv = process.argv;

/** The template name `snapshot.ts` derives from the migrations and the generator. */
function snapshotTemplate(): string {
  const hash = createHash('sha256');
  const sources = [
    ...readdirSync('migrations')
      .filter((name) => name.endsWith('.sql'))
      .toSorted()
      .map((name) => `migrations/${name}`),
    ...['shape', 'cast', 'generate'].map((name) => `tests/fixture/${name}.ts`),
  ];
  for (const source of sources) hash.update(source).update(readFileSync(source));
  return `fixture_${hash.digest('hex').slice(0, 16)}`;
}

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
    const beforeDatabases = await databases();
    const clone = `fixture_sol_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    try {
      process.argv = ['node', 'tests/fixture/snapshot.ts', 'build'];
      await expect(import('./snapshot.ts')).resolves.toBeDefined();
      const template = (await databases()).find(
        (name) => name.startsWith('fixture_') && !beforeDatabases.includes(name),
      );
      expect(template).toBeDefined();
      await server.execute(`create database "${clone}" template "${template}"`);
      expect(await databases()).toContain(clone);
    } finally {
      process.argv = originalArgv;
      // The build renames its own database to the template, so the template
      // is this case's only when the build seeded one.
      const own = [...built.databases, clone];
      if (built.databases.length > 0) own.push(snapshotTemplate());
      await Promise.all(
        own.map(
          async (name) => await server.execute(`drop database if exists "${name}" with (force)`),
        ),
      );
      await Promise.all(
        built.roles.map(async (name) => await server.execute(`drop role if exists "${name}"`)),
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

it.skipIf(serverUrl === undefined)(
  'the clone fallback refuses a FIXTURE_PG_CONTAINER that is not a container name, creating nothing',
  async () => {
    const template = snapshotTemplate();
    const target = `fixture_refused_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    const container = process.env['FIXTURE_PG_CONTAINER'];
    try {
      await reader`select 1`;
      // docker would read it as its own option, and `--help` exits 0.
      process.env['FIXTURE_PG_CONTAINER'] = '--help';
      process.argv = ['node', 'tests/fixture/snapshot.ts', 'clone', target];
      vi.resetModules();
      await expect(import('./snapshot.ts')).rejects.toThrow(
        'fixture: FIXTURE_PG_CONTAINER "--help" is not a container name or id',
      );
      const made = await server.execute<{ datname: string }>(
        'select datname from pg_database where datname = $1',
        [target],
      );
      expect(made).toHaveLength(0);
    } finally {
      if (container === undefined) delete process.env['FIXTURE_PG_CONTAINER'];
      else process.env['FIXTURE_PG_CONTAINER'] = container;
      process.argv = originalArgv;
      await reader.end();
      await server.execute(`drop database if exists "${target}" with (force)`);
      if (created) await server.execute(`drop database "${template}" with (force)`);
      await server.close();
    }
  },
  120_000,
);
