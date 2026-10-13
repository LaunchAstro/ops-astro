// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm verify:upgrade-drill [--from <version>] [--base <commit>] [--json]`.
// Its own throwaway database is seeded through the older commit's product.
// The application stops before upgrade, enforced by the migration runner.
// Owner-visible snapshots preserve stored rows at every declaration boundary.
// Row changes name columns and predicates; drops name empty tables. New rows
// and columns are allowed. Undeclared changes and unused declarations fail.
// CI supplies the base's newest migration and commit; --from defaults to 0023.
// Exit 0 for pass, 1 for failure, 2 for refusal. --json prints the final result.

import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { Failure, baseCommit, seed } from './upgrade-drill-seed.mjs';
import * as changes from './upgrade-drill-changes.mjs';

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
// eslint-disable-next-line max-lines-per-function -- one throwaway database, made and dropped in one place
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

/**
 * Compare undeclared batches and each declared migration at their own boundaries.
 * A table created during the upgrade therefore exists before its declared drop,
 * and a later declaration cannot excuse an earlier undeclared change.
 */
async function upgrade(db, directory, all, at, before) {
  const boundaries = new Set([all.length - 1]);
  for (let index = at + 1; index < all.length; index += 1) {
    if (changes.hasDeclarations(directory, all[index].version)) {
      if (index - 1 > at) boundaries.add(index - 1);
      boundaries.add(index);
    }
  }
  const applied = [];
  const differences = [];
  const declared = [];
  const droppedTables = new Set();
  let previous = at;
  for (const boundary of [...boundaries].toSorted((a, b) => a - b)) {
    const declarations = changes.readDeclarations(
      directory,
      all.slice(previous + 1, boundary + 1),
      before,
      Refused,
      droppedTables,
    );
    // oxlint-disable-next-line no-await-in-loop -- each declaration sees its migration's before state
    await changes.declaredRows(db.admin, declarations);
    // oxlint-disable-next-line no-await-in-loop -- apply the ordered batch before comparing it
    const outcome = await applyMigrations(db.admin, all.slice(0, boundary + 1));
    applied.push(...outcome.applied);
    // oxlint-disable-next-line no-await-in-loop -- compare the batch, omitting newly added columns
    const after = await snapshot(db.admin, before);
    differences.push(...changes.compare(before, after, declarations));
    declared.push(...declarations.map((one) => changes.resultOf(one)));
    if (boundary !== all.length - 1) {
      // oxlint-disable-next-line no-await-in-loop -- the next boundary needs all columns' actual values
      before = await snapshot(db.admin);
    }
    previous = boundary;
  }
  return { applied, differences, declared };
}

async function drill({ url, from, directory, base }) {
  const all = readMigrations(directory);
  const at = all.findIndex((m) => m.version === from || m.version.startsWith(`${from}_`));
  if (at === -1) throw new Refused(`no migration ${from} among the ${all.length} read`);
  if (at === all.length - 1)
    throw new Refused(`${all[at].version} is the head: nothing to upgrade`);
  const start = all[at].version;
  const to = all.at(-1).version;
  const { commit, refused } = baseCommit(start, base);
  if (refused !== undefined) throw new Refused(refused);

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
    await seed(db.app, commit);
    // The application stopped: the seed's pool is closed and holds no session.
    await db.closeSessions();
    const before = await snapshot(db.admin);
    const rows = [...before.values()].reduce((sum, t) => sum + t.rows.length, 0);
    if (rows === 0)
      throw new Failure('the seed left no row the owner can read, so nothing would be compared');
    say(
      `built at ${start} and seeded through ${commit.slice(0, 7)}'s commands: ` +
        `${rows} rows in ${before.size} tables; application stopped`,
    );
    const { applied, differences, declared } = await upgrade(db, directory, all, at, before);
    say(`upgraded ${start} -> ${to}: applied ${applied.join(', ')}`);
    return {
      ok: differences.length === 0 && declared.every((one) => changes.fulfilled(one)),
      from: start,
      to,
      applied,
      tables: before.size,
      rows,
      differences,
      declared,
    };
  } finally {
    await db.drop();
  }
}

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: '0023' },
    base: { type: 'string' },
    migrations: { type: 'string', default: `${root}migrations` },
    json: { type: 'boolean', default: false },
  },
});

const url = serverUrl();
try {
  if (!url) throw new Refused('no DATABASE_ADMIN_URL. Run scripts/local/db-up.sh first.');
  const result = await drill({
    url,
    from: values.from,
    directory: values.migrations,
    base: values.base,
  });
  for (const d of result.differences) {
    say(
      d.gone
        ? `${d.table}: table gone, ${d.changedOrLost} row(s) lost`
        : `${d.table}: ${d.changedOrLost} row${d.changedOrLost === 1 ? '' : 's'} changed or lost, ${d.added} added`,
    );
  }
  for (const line of changes.declaredReport(result.declared)) say(line);
  say(
    result.ok
      ? `passed: ${result.rows} rows in ${result.tables} tables unchanged from ${result.from} to ${result.to}`
      : `FAILED: ${result.differences.length} table(s) changed and ` +
          `${result.declared.filter((d) => !changes.fulfilled(d)).length} declared change(s) missing ` +
          `from ${result.from} to ${result.to}`,
  );
  if (values.json) console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(
    `upgrade-drill: ${error instanceof Refused ? 'refused' : 'failed'}: ${printable(error)}`,
  );
  process.exitCode = error instanceof Refused ? 2 : 1;
}
