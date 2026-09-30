// SPDX-License-Identifier: AGPL-3.0-only
//
// The upgrade drill: `pnpm verify:upgrade-drill [--from <version>]`.
//
// It builds its own starting point and never touches an installation's data:
// a throwaway database on the local server, migrated to an older version and
// seeded there through the product's own commands, then upgraded to the head
// with the application stopped, then compared row for row. Every row that
// existed before the upgrade must still exist after it with the same values.
// A column a migration adds is not compared, because it holds no value the
// installation stored; a row a migration adds is counted and allowed. A row
// changed or lost, or a table gone, fails the drill. The report names tables
// and counts and never a row's content.
//
// The first drill was run by hand before slice one landed (0023 through 0031,
// 217 records identical) and its script was never committed; 0023 is the
// default for that reason. CI runs it from the base branch's newest migration
// whenever a pull request adds one (.github/workflows/ci.yml, `database
// conformance`). The seed runs this checkout's commands against the older
// schema, so it can seed only where the head's commands still fit that schema.
//
// "The application stopped" is the supported upgrade (scripts/db-migrate.mjs):
// the seed's pool is closed before the runner starts, and the runner refuses
// if any other session is still connected.
//
// Exit 0 when every row is unchanged, 1 when the drill fails, 2 when it is
// refused before building anything. `--json` adds the result as a last line.

import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { Failure, seed } from './upgrade-drill-seed.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const LEDGER = 'ops.schema_migrations';

const say = (line) => console.log(`upgrade-drill: ${line}`);

/**
 * The drill's own throwaway database: a new database, and a login of its own
 * in the application's group role that the migrations grant to. It is built
 * here, not borrowed from the test harness, because a check that imports a
 * test fixture proves the fixture (.dependency-cruiser.cjs). The login's
 * password is random base64url, whose alphabet holds no quote, and the names
 * are generated here, so nothing a caller supplies reaches the SQL.
 */
async function throwawayDatabase(clusterUrl) {
  const name = `t1_drill_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const login = `${name}_app`;
  const password = randomBytes(24).toString('base64url');
  const urlFor = (user, secret) => {
    const url = new URL(clusterUrl);
    url.pathname = `/${name}`;
    if (user !== undefined) url.username = encodeURIComponent(user);
    if (secret !== undefined) url.password = encodeURIComponent(secret);
    return url.toString();
  };
  const drops = [
    `drop database if exists "${name}" with (force)`,
    `drop role if exists "${login}"`,
  ];
  const dropAll = async () => {
    const server = connectAsAdmin(clusterUrl, { source: 'harness' });
    try {
      for (const statement of drops) {
        // oxlint-disable-next-line no-await-in-loop -- the database before its role
        await server.execute(statement);
      }
    } finally {
      await server.close();
    }
  };
  const server = connectAsAdmin(clusterUrl, { source: 'harness' });
  try {
    await server.execute(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = 'ops_astro_app') then
           create role ops_astro_app nologin;
         end if;
       end $$`,
    );
    await server.execute(`create database "${name}"`);
    await server.execute(`revoke temporary on database "${name}" from public`);
    await server.execute(
      `create role "${login}" login password '${password}' ` +
        'nosuperuser nocreatedb nocreaterole nobypassrls inherit in role ops_astro_app',
    );
  } catch (error) {
    await server.close();
    await dropAll();
    throw error;
  }
  await server.close();
  const admin = connectAsAdmin(urlFor(), { source: 'migration' });
  let pool = connect(urlFor(login, password), { source: 'runtime' });
  return {
    admin,
    // A fixed face over the pool `closeSessions` replaces.
    app: {
      get log() {
        return pool.log;
      },
      withBusiness: async (business, run) => await pool.withBusiness(business, run),
      close: async () => await pool.close(),
    },
    async closeSessions() {
      await pool.close();
      pool = connect(urlFor(login, password), { source: 'runtime' });
    },
    async drop() {
      await pool.close();
      await admin.close();
      await dropAll();
    },
  };
}

class Refused extends Error {}

/**
 * What an error may say on the way out. The runner's message quotes the failed
 * statement and the server's error may quote a row, so a migration failure is
 * named by its version and SQLSTATE alone, and any other foreign error by its
 * name and SQLSTATE.
 */
function printable(error) {
  if (error instanceof Refused || error instanceof Failure) return error.message;
  const code = [error?.cause?.code, error?.code].find((c) => /^[0-9A-Z]{5}$/u.test(c ?? ''));
  const state = code === undefined ? '' : ` (SQLSTATE ${code})`;
  const failed = /^migrate: (\S+) (?:failed|ended the run's transaction) on:/u.exec(
    error?.message ?? '',
  );
  if (failed)
    return `migration ${failed[1]} failed${state}; its statement and the server's message are withheld`;
  return `${error?.name ?? 'Error'}${state}; its message is withheld, as it may quote a row`;
}

/** `.local/db.env` is what `scripts/local/db-up.sh` writes. The environment wins. */
function serverUrl() {
  const set = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (set) return set;
  return readEnvFile(`${root}.local/db.env`)['DATABASE_ADMIN_URL'] || undefined;
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Every ordinary table and its rows as `jsonb` text, read as the owner. Given
 * the snapshot before, a table's rows are read without the columns added since.
 */
async function snapshot(admin, before) {
  const tables = await admin.execute(
    `select n.nspname || '.' || c.relname as name, n.nspname as schema, c.relname as relname,
            array(select a.attname::text from pg_attribute a
                   where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
      order by 1`,
  );
  const shot = new Map();
  for (const table of tables) {
    if (table.name === LEDGER) continue;
    const earlier = before?.get(table.name)?.columns ?? table.columns;
    const added = table.columns.filter((column) => !earlier.includes(column));
    // oxlint-disable-next-line no-await-in-loop
    const rows = await admin.execute(
      `select (to_jsonb(t) - $1::text[])::text as row from ${quote(table.schema)}.${quote(table.relname)} t`,
      [added],
    );
    shot.set(table.name, { columns: table.columns, rows: rows.map((r) => r.row) });
  }
  return shot;
}

/** Each table whose earlier rows are not all still there, unchanged. */
function compare(before, after) {
  const differences = [];
  for (const [table, { rows }] of before) {
    const now = after.get(table);
    if (now === undefined) {
      differences.push({ table, changedOrLost: rows.length, added: 0, gone: true });
      continue;
    }
    const waiting = new Map();
    for (const row of rows) waiting.set(row, (waiting.get(row) ?? 0) + 1);
    let added = 0;
    for (const row of now.rows) {
      const count = waiting.get(row) ?? 0;
      if (count > 0) waiting.set(row, count - 1);
      else added += 1;
    }
    const changedOrLost = [...waiting.values()].reduce((sum, n) => sum + n, 0);
    if (changedOrLost > 0) differences.push({ table, changedOrLost, added, gone: false });
  }
  return differences;
}

async function drill({ url, from, directory }) {
  const all = readMigrations(directory);
  const at = all.findIndex((m) => m.version === from || m.version.startsWith(`${from}_`));
  if (at === -1) throw new Refused(`no migration ${from} among the ${all.length} read`);
  if (at === all.length - 1)
    throw new Refused(`${all[at].version} is the head: nothing to upgrade`);
  const start = all[at].version;
  const to = all.at(-1).version;

  // The seed's approval is signed. A throwaway key for this process, unless one is set.
  process.env.GATE_SIGNING_KEY_ID ??= 'upgrade-drill/throwaway@1';
  process.env.GATE_SIGNING_SECRET ??= randomBytes(32).toString('hex');
  const db = await throwawayDatabase(url);
  try {
    // Row security would hide rows from the snapshot and the drill would pass
    // over what it could not see, so the owner must be above it.
    const [owner] = await db.admin.execute(
      `select rolsuper or rolbypassrls as above from pg_roles where rolname = current_user`,
    );
    if (owner?.above !== true) throw new Refused('the owner role is subject to row security');
    await applyMigrations(db.admin, all.slice(0, at + 1));
    await seed(db.app);
    // The application stopped: the seed's pool is closed and holds no session.
    await db.closeSessions();
    const before = await snapshot(db.admin);
    const rows = [...before.values()].reduce((sum, t) => sum + t.rows.length, 0);
    if (rows === 0)
      throw new Failure('the seed left no row the owner can read, so nothing would be compared');
    say(`built at ${start} and seeded: ${rows} rows in ${before.size} tables; application stopped`);
    const { applied } = await applyMigrations(db.admin, all);
    say(`upgraded ${start} -> ${to}: applied ${applied.join(', ')}`);
    const differences = compare(before, await snapshot(db.admin, before));
    return {
      ok: differences.length === 0,
      from: start,
      to,
      applied,
      tables: before.size,
      rows,
      differences,
    };
  } finally {
    await db.drop();
  }
}

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: '0023' },
    migrations: { type: 'string', default: `${root}migrations` },
    json: { type: 'boolean', default: false },
  },
});

const url = serverUrl();
try {
  if (!url) throw new Refused('no DATABASE_ADMIN_URL. Run scripts/local/db-up.sh first.');
  const result = await drill({ url, from: values.from, directory: values.migrations });
  for (const d of result.differences) {
    say(
      d.gone
        ? `${d.table}: table gone, ${d.changedOrLost} row(s) lost`
        : `${d.table}: ${d.changedOrLost} row${d.changedOrLost === 1 ? '' : 's'} changed or lost, ${d.added} added`,
    );
  }
  say(
    result.ok
      ? `passed: ${result.rows} rows in ${result.tables} tables unchanged from ${result.from} to ${result.to}`
      : `FAILED: ${result.differences.length} table(s) changed from ${result.from} to ${result.to}`,
  );
  if (values.json) console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(
    `upgrade-drill: ${error instanceof Refused ? 'refused' : 'failed'}: ${printable(error)}`,
  );
  process.exitCode = error instanceof Refused ? 2 : 1;
}
