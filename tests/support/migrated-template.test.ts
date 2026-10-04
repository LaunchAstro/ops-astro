// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (NATHAN-CF-RECORD item 1): every database-bound file used to
// migrate its own database from empty, and migration 0008's lock on a
// cluster-wide role queued those migrations one behind another. Each run now
// migrates one template from empty, once, and a file's database is a clone of
// it. That is only worth having if a clone is the database a migration from
// empty makes, so this proves it is, catalogue entry for catalogue entry,
// database privilege for privilege, and keeps the from-empty path for the
// callers that need it.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, onTestFinished } from 'vitest';

import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { catalogueOf, databaseFactsOf } from './database-catalogue.ts';
import {
  createEmptyDatabase,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from './fresh-database.ts';
import { besideUrl } from './global-setup.ts';
import { ensureMigratedTemplate, TEMPLATE_SWITCH, templateName } from './migrated-template.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) {
  console.warn('migrated template: DATABASE_URL is unset, so nothing below ran.');
}

const onDisk = readdirSync('migrations')
  .filter((name) => name.endsWith('.sql'))
  .toSorted()
  .map((name) => name.slice(0, -'.sql'.length));
const FULL = { applied: onDisk, alreadyApplied: [] };

/** Whether this database's own trail holds a migration's DDL: built from empty, not cloned. */
const migratedHere = (db: FreshDatabase) =>
  db.log.schemaChanging().some((entry) => entry.source === 'migration');

async function onServer<T>(run: (server: AdminConnection) => Promise<T>): Promise<T> {
  const server = connectAsAdmin(besideUrl(serverUrl as string));
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

const templateRow = async (name: string) =>
  (
    await onServer((server) =>
      server.execute<{ connections: boolean; comment: string | null }>(
        `select datallowconn connections, shobj_description(oid, 'pg_database') comment
           from pg_database where datname = $1`,
        [name],
      ),
    )
  )[0];

const run = promisify(execFile);
/**
 * ensureMigratedTemplate in a node process of its own, its answer read back.
 * The server's address goes by environment, so a failure's command line,
 * which names the arguments, carries no credential.
 */
async function builderProcess(name: string): Promise<unknown> {
  const script =
    "const m = await import('./tests/support/migrated-template.ts');" +
    'const built = await m.ensureMigratedTemplate(process.env.TEMPLATE_SERVER_URL, process.argv[1]);' +
    'console.log(JSON.stringify(built));';
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, name], {
    encoding: 'utf8',
    env: { ...process.env, TEMPLATE_SERVER_URL: serverUrl },
  });
  return JSON.parse(stdout) as unknown;
}

const ledgerSize = async (admin: AdminConnection) =>
  (await admin.execute<{ n: string }>('select count(*)::text n from ops.schema_migrations'))[0]?.n;

const made: FreshDatabase[] = [];
afterAll(async () => {
  for (const db of made) await db.drop(); // eslint-disable-line no-await-in-loop -- in order
});
const keep = (db: FreshDatabase) => {
  made.push(db);
  return db;
};

describe('the template name', () => {
  it('follows the code that applies the migrations: a change to any of it names a new template', () => {
    const root = mkdtempSync(join(tmpdir(), 'tpl-harness-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const tenancy = 'packages/core-records/src/tenancy';
    const self = 'tests/support/migrated-template.ts';
    cpSync(tenancy, join(root, tenancy), { recursive: true });
    cpSync(self, join(root, self));
    expect(templateName('migrations', root)).toBe(templateName());
    for (const file of ['migrate.ts', 'statements.ts', 'database.ts', 'migration-ids.ts']) {
      const path = join(root, tenancy, file);
      const before = readFileSync(path);
      writeFileSync(path, '// one byte more\n', { flag: 'a' });
      expect(templateName('migrations', root), file).not.toBe(templateName());
      writeFileSync(path, before);
    }
  });
});

describe.skipIf(serverUrl === undefined)('the migrated template', () => {
  theTemplate();
  aClone();
  theWaysAroundIt();
});

function theTemplate() {
  it('global setup built it under its digest name before any file ran, and nobody may connect to it', async () => {
    const row = await templateRow(templateName());
    expect(row?.connections).toBe(false);
    expect(JSON.parse(row?.comment ?? '{}')).toMatchObject({ migration: FULL });
  });

  it('a template left half built is rebuilt from empty, by one builder of many', async () => {
    const name = `migrated_test${randomBytes(6).toString('hex')}`;
    const target = `t1_tplhalf_${randomBytes(6).toString('hex')}`;
    onTestFinished(() =>
      onServer(async (server) => {
        await server.execute(`drop database if exists "${target}" with (force)`);
        await server.execute(`drop database if exists "${name}" with (force)`);
      }),
    );
    // A builder that stopped after create: connectable, no comment, no schema.
    await onServer((server) => server.execute(`create database "${name}"`));
    // Three builders in three processes, so only the server's lock keeps them apart.
    const built = await Promise.all([
      ensureMigratedTemplate(serverUrl as string, name),
      builderProcess(name),
      builderProcess(name),
    ]);
    expect(built).toStrictEqual([1, 2, 3].map(() => ({ name, migration: FULL })));
    expect((await templateRow(name))?.connections).toBe(false);
    // What was built is the migrations' own output: a copy of it holds the full ledger.
    await onServer((server) => server.execute(`create database "${target}" template "${name}"`));
    const url = new URL(serverUrl as string);
    url.pathname = `/${target}`;
    const copy = connectAsAdmin(url.toString());
    try {
      expect(await ledgerSize(copy)).toBe(String(onDisk.length));
    } finally {
      await copy.close();
    }
  }, 300_000);

  it('a changed migration names a new template; the same files name the same one', () => {
    const copy = mkdtempSync(join(tmpdir(), 'tpl-digest-'));
    onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
    cpSync('migrations', copy, { recursive: true });
    expect(templateName()).toMatch(/^migrated_[0-9a-f]{16}$/u);
    expect(templateName(copy)).toBe(templateName());
    writeFileSync(join(copy, `${onDisk.at(-1) ?? ''}.sql`), '-- one byte more\n', { flag: 'a' });
    expect(templateName(copy)).not.toBe(templateName());
  });
}

function aClone() {
  it('equals a database migrated from empty: catalogue, privileges, settings, roles and migration result', async () => {
    const [clone, fromEmpty] = await Promise.all([
      createFreshDatabase({ part: 'tplclone' }).then(keep),
      createFreshDatabase({ part: 'tplempty', fromEmpty: true }).then(keep),
    ]);
    // Each took the path it names: the clone ran no migration of its own.
    expect([migratedHere(clone), migratedHere(fromEmpty)]).toStrictEqual([false, true]);
    expect(clone.migration).toStrictEqual(FULL);
    expect(fromEmpty.migration).toStrictEqual(FULL);
    const cloned = await catalogueOf(clone.admin);
    expect(cloned.length).toBeGreaterThan(onDisk.length);
    expect(cloned).toStrictEqual(await catalogueOf(fromEmpty.admin));
    const facts = await onServer((server) => databaseFactsOf(server, clone.name));
    expect(facts).toStrictEqual(
      await onServer((server) => databaseFactsOf(server, fromEmpty.name)),
    );
    // A clone takes connections, unlike its template.
    expect(facts.find((fact) => fact.startsWith('database '))).toContain(' connections=t ');
    // 0031's revokes do not survive a clone on their own, so they are asked by name.
    const asked = await onServer((server) =>
      server.execute<{ who: string; temp: boolean; connect: boolean }>(
        `select who, has_database_privilege(who, $1, 'TEMP') temp,
                has_database_privilege(who, $1, 'CONNECT') connect
           from unnest(array['public', 'ops_astro_app', $2, $3]) who`,
        [clone.name, clone.loginRole, clone.restrictedRole],
      ),
    );
    expect(asked.map(({ temp }) => temp)).toStrictEqual([false, false, false, false]);
    expect(asked.find(({ who }) => who === clone.restrictedRole)?.connect).toBe(true);
  }, 300_000);

  it('clones made side by side each get a database of their own', async () => {
    const clones = await Promise.all(
      [1, 2, 3, 4].map(async (n) =>
        keep(await createFreshDatabase({ part: `tplside${String(n)}` })),
      ),
    );
    expect(new Set(clones.map((db) => db.name)).size).toBe(4);
    expect(clones.map((db) => migratedHere(db))).toStrictEqual([false, false, false, false]);
    const ledgers = await Promise.all(clones.map((db) => ledgerSize(db.admin)));
    expect(ledgers).toStrictEqual(clones.map(() => String(onDisk.length)));
  }, 300_000);
}

function theWaysAroundIt() {
  it('a custom migrations directory and the switch turned off migrate from empty', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'tpl-custom-'));
    onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
    cpSync('migrations', copy, { recursive: true });
    const custom = keep(
      await createFreshDatabase({ part: 'tplcustom', migrationsDirectory: copy }),
    );
    expect(migratedHere(custom)).toBe(true);

    const before = process.env[TEMPLATE_SWITCH];
    process.env[TEMPLATE_SWITCH] = 'off';
    onTestFinished(() => {
      if (before === undefined) delete process.env[TEMPLATE_SWITCH];
      else process.env[TEMPLATE_SWITCH] = before;
    });
    expect(migratedHere(keep(await createFreshDatabase({ part: 'tploff' })))).toBe(true);
  }, 300_000);

  it('createEmptyDatabase still holds no schema at all', async () => {
    const empty = await createEmptyDatabase({ part: 'tplbare' });
    try {
      const [row] = await empty.admin.execute<{ ledger: string | null }>(
        `select to_regclass('ops.schema_migrations')::text ledger`,
      );
      expect(row?.ledger).toBeNull();
    } finally {
      await empty.drop();
    }
  });
}
