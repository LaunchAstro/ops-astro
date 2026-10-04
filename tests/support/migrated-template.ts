// SPDX-License-Identifier: AGPL-3.0-only
//
// One migrated template per run (CI-SPEED, NATHAN-CF-RECORD item 1).
//
// Every database-bound file used to migrate its own database from empty, and
// migration 0008 comments on a cluster-wide role inside the one migration
// transaction, so every migration on the server waited for the one before it
// to commit. A conformance shard spends most of its time in that queue.
//
// So the migrations run from empty once per server and tree, into a database
// named after a digest of the migration files and of this harness, and every
// fresh database is a copy of it (`create database ... template ...`). The
// template is still the migrations' own output from empty, which is the point
// fresh-database.ts makes about schemas nobody can install; it is just made
// once. A clone does not carry the database's own privileges, so
// fresh-database.ts copies them from the template, as 0031's revokes need.
//
// The template is finished when it carries its migration result as its
// comment and takes no connections. Anything else under its name, a builder
// that stopped half way, is dropped and built again. Builders take an
// advisory lock, so two runs on one server build it once between them.
//
// It works through the database beside the configured one (`besideUrl`):
// scripts/db-conformance.mjs reads the configured database's transaction
// counter either side of each named suite, and the template is not the suite's
// work. `OPS_ASTRO_DB_TEMPLATE=off` turns it all off, and every fresh database
// migrates from empty as before.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { migrate, type MigrationOutcome } from '../../packages/core-records/src/tenancy/migrate.ts';

/**
 * The same server, connected to a database other than the configured one:
 * `postgres`, or `template1` when the configured database is `postgres`.
 * Both exist on every cluster `initdb` makes. With no database in the URL,
 * the configured one is the user's name, as it is for libpq.
 */
export function besideUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  const configured =
    decodeURIComponent(url.pathname.replace(/^\//u, '')) || decodeURIComponent(url.username);
  url.pathname = configured === 'postgres' ? '/template1' : '/postgres';
  return url.toString();
}

/** `off` makes every fresh database migrate from empty, as before the template. */
export const TEMPLATE_SWITCH = 'OPS_ASTRO_DB_TEMPLATE';

export interface MigratedTemplate {
  readonly name: string;
  readonly migration: MigrationOutcome;
}

/** Whether fresh databases are cloned from the template; `OPS_ASTRO_DB_TEMPLATE=off` says not. */
export function templateEnabled(): boolean {
  return process.env[TEMPLATE_SWITCH] !== 'off';
}

/** What the template's content follows from, besides the migrations. */
const HARNESS = [
  'tests/support/migrated-template.ts',
  'packages/core-records/src/tenancy/migrate.ts',
  'packages/core-records/src/tenancy/statements.ts',
];

/**
 * `migrated_` and 16 hex digits of a digest of every migration file, by name
 * and content, and of the harness that applies them. A changed file names a
 * new template, so a stale one is never cloned.
 */
export function templateName(migrationsDirectory = 'migrations'): string {
  const hash = createHash('sha256');
  const files = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  for (const file of files) {
    hash
      .update(`${file}\0`)
      .update(readFileSync(join(migrationsDirectory, file)))
      .update('\0');
  }
  for (const file of HARNESS) hash.update(`${file}\0`).update(readFileSync(file)).update('\0');
  return `migrated_${hash.digest('hex').slice(0, 16)}`;
}

const LOCK = "select pg_advisory_lock(hashtext('ops-astro migrated template'))";
const UNLOCK = "select pg_advisory_unlock(hashtext('ops-astro migrated template'))";

function quoted(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** The migration result a finished template carries, or undefined for anything less. */
function finished(
  row: { connections: boolean; comment: string | null } | undefined,
): MigrationOutcome | undefined {
  if (row === undefined || row.connections || row.comment === null) return undefined;
  try {
    const { migration } = JSON.parse(row.comment) as { migration?: MigrationOutcome };
    return Array.isArray(migration?.applied) && Array.isArray(migration.alreadyApplied)
      ? migration
      : undefined;
  } catch {
    return undefined;
  }
}

const built = new Map<string, Promise<MigratedTemplate>>();

/**
 * The finished template `name` on the server `serverUrl` names, built from
 * empty first if it is not there. Once per process and name; any number of
 * processes may ask at once.
 */
export function ensureMigratedTemplate(
  serverUrl: string,
  name: string = templateName(),
): Promise<MigratedTemplate> {
  const key = `${new URL(serverUrl).host} ${name}`;
  const known = built.get(key);
  if (known !== undefined) return known;
  const building = build(serverUrl, name);
  built.set(key, building);
  // A failed build is not remembered: the next caller tries again.
  building.catch(() => built.delete(key));
  return building;
}

async function build(serverUrl: string, name: string): Promise<MigratedTemplate> {
  const server = connectAsAdmin(besideUrl(serverUrl), { source: 'harness' });
  const read = async () =>
    finished(
      (
        await server.execute<{ connections: boolean; comment: string | null }>(
          `select datallowconn connections, shobj_description(oid, 'pg_database') comment
             from pg_database where datname = $1`,
          [name],
        )
      )[0],
    );
  try {
    const ready = await read();
    if (ready !== undefined) return { name, migration: ready };
    await server.execute(LOCK);
    try {
      // Another builder may have finished while this one waited.
      const now = await read();
      if (now !== undefined) return { name, migration: now };
      return { name, migration: await buildFromEmpty(server, serverUrl, name) };
    } finally {
      await server.execute(UNLOCK);
    }
  } finally {
    await server.close();
  }
}

async function buildFromEmpty(
  server: ReturnType<typeof connectAsAdmin>,
  serverUrl: string,
  name: string,
): Promise<MigrationOutcome> {
  await server.execute(`drop database if exists ${quoted(name)} with (force)`);
  await server.execute(`create database ${quoted(name)}`);
  // As fresh-database.ts does for every database it makes.
  await server.execute(`revoke temporary on database ${quoted(name)} from public`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const admin = connectAsAdmin(url.toString(), { source: 'migration' });
  let migration: MigrationOutcome;
  try {
    migration = await migrate(admin, 'migrations');
  } finally {
    await admin.close();
  }
  // A clone carries neither a database's settings nor its comment. None of the
  // migrations sets one; if one ever does, say so rather than clone without it.
  const [settings] = await server.execute<{ n: string }>(
    `select count(*)::text n from pg_db_role_setting
      where setdatabase = (select oid from pg_database where datname = $1)`,
    [name],
  );
  if (settings?.n !== '0') {
    throw new Error(
      `migrated template: the migrations set ${String(settings?.n)} database setting(s), which a ` +
        `clone does not carry; copy them in fresh-database.ts, or set ${TEMPLATE_SWITCH}=off`,
    );
  }
  const comment = JSON.stringify({ migration }).replaceAll("'", "''");
  await server.execute(`comment on database ${quoted(name)} is '${comment}'`);
  await server.execute(`alter database ${quoted(name)} allow_connections false`);
  return migration;
}
