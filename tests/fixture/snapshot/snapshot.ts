// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a: the snapshot, the one seeding mechanism (RN-09). `build` seeds the full
// shape through the commands once, outside any timed run, into a template
// named for the migrations' and the generator's digest; `clone <name>` copies
// it into a fresh database in well under a second. A template whose digest is
// not the tree's is stale: `clone` refuses it by name and exits 2.
// Run it through `scripts/local/fixture-snapshot.sh`.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { connectAsAdmin } from '../../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../../support/fresh-database.ts';
import { seedFixture } from '../generate.ts';
import { FIXTURE_SHAPE } from '../shape.ts';

const sources = [
  ...readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .toSorted()
    .map((f) => `migrations/${f}`),
  ...['shape', 'cast', 'generate'].map((f) => `tests/fixture/${f}.ts`),
];
const hash = createHash('sha256');
for (const file of sources) hash.update(file).update(readFileSync(file));
const key = hash.digest('hex').slice(0, 16);
const template = `fixture_${key}`;

const serverUrl = databaseUrlFromEnvironment() ?? '';

/**
 * A template copy, or, while anything is connected to the template (55006),
 * a dump and restore inside the local server's container (RN-09). That
 * container is `FIXTURE_PG_CONTAINER`, and the copy refuses one that is not
 * DATABASE_URL's own server. Names go in as positional arguments, never into
 * the shell text.
 */
async function copy(target: string): Promise<string> {
  const via = await copyData(target);
  await copyPrivileges(target);
  return via;
}

/**
 * A new database starts with the default privileges, PUBLIC's TEMP among
 * them, whatever the template's are (0031 revokes it). Give the copy the
 * template's own, entry for entry.
 */
async function copyPrivileges(target: string): Promise<void> {
  await server.execute(`revoke all on database "${target}" from public`);
  const entries = await server.execute<{ grantee: string | null; privilege: string }>(
    `select case when a.grantee = 0 then null else pg_get_userbyid(a.grantee) end grantee,
            a.privilege_type privilege
       from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      where d.datname = $1`,
    [template],
  );
  const grants = entries.map(({ grantee, privilege }) => {
    if (!/^[A-Z]+$/u.test(privilege)) throw new Error(`fixture: unexpected privilege ${privilege}`);
    const to = grantee === null ? 'public' : `"${grantee.replaceAll('"', '""')}"`;
    return `grant ${privilege} on database "${target}" to ${to}`;
  });
  for (const grant of grants) await server.execute(grant); // eslint-disable-line no-await-in-loop
}

async function copyData(target: string): Promise<string> {
  try {
    await server.execute(`create database "${target}" template "${template}"`);
    return 'template';
  } catch (error) {
    if ((error as { code?: string }).code !== '55006') throw error;
  }
  const user = decodeURIComponent(new URL(serverUrl).username);
  const container = process.env['FIXTURE_PG_CONTAINER'] ?? 'ops-astro-local-pg';
  // A container's name or id, never a word docker would read as its own option.
  if (!/^[A-Za-z0-9][\w.-]*$/u.test(container)) {
    throw new Error(
      `fixture: FIXTURE_PG_CONTAINER ${JSON.stringify(container)} is not a container name or id`,
    );
  }
  const [row] = await server.execute<{ identity: string | null }>(IDENTITY);
  const identity = row?.identity ?? '';
  if (identity === '') throw new Error('fixture: the DATABASE_URL server gave no identity');
  // The container proves it runs DATABASE_URL's server before it creates
  // anything, asking over the socket the copy then uses.
  const script = [
    '[ -n "$4" ] && [ "$(psql -U "$1" -d postgres -XAtc "$5")" = "$4" ] || {',
    '  printf "fixture: container %s is not the DATABASE_URL server;' +
      ' set FIXTURE_PG_CONTAINER to its container. Nothing was created." "$6" >&2; exit 1; }',
    'createdb -U "$1" -T template0 "$3" && pg_dump -U "$1" -Fc "$2" | pg_restore -U "$1" -d "$3"',
  ].join('\n');
  const positional = [user, template, target, identity, IDENTITY, container];
  const args = ['exec', container, 'sh', '-c', script, 'copy', ...positional];
  const run = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (run.status !== 0) {
    // A docker that never started has no stderr to read.
    const why = (run.stderr as string | null)?.trim() ?? '';
    throw new Error(`fixture: dump and restore failed (${String(run.status)})${why && `: ${why}`}`);
  }
  return 'dump-restore';
}

/**
 * A server's identity: its cluster's system identifier and the start of its
 * postmaster. A copy of the cluster shares the first; its start tells them apart.
 */
const IDENTITY = `select system_identifier::text || '|' ||
  extract(epoch from pg_postmaster_start_time())::text as identity from pg_control_system()`;
const server = connectAsAdmin(serverUrl, { source: 'harness' });
const [verb, target] = process.argv.slice(2);
try {
  const found = await server.execute<{ datname: string }>(
    `select datname from pg_database where datname like 'fixture\\_%' order by datname`,
  );
  const names = found.map((row) => row.datname);
  const stale = names.filter((name) => name !== template);
  if (verb === 'build' && !names.includes(template)) {
    const db = await createFreshDatabase({ part: 'fixture' });
    const report = await seedFixture(db, FIXTURE_SHAPE);
    await db.app.close();
    await db.admin.close();
    console.log(
      JSON.stringify({ template, key, seedMs: report.seedMs, heldBack: report.heldBack, stale }),
    );
    await server.execute(`alter database "${db.name}" rename to "${template}"`);
    // The run's two logins hold connect on the database; a clone needs neither.
    const roles = `"${db.loginRole}", "${db.restrictedRole}"`;
    await server.execute(`revoke all on database "${template}" from ${roles}`);
    await server.execute(`drop role ${roles}`);
  } else if (verb === 'build') {
    console.log(JSON.stringify({ template, key, reused: true, stale }));
  } else if (verb === 'clone' && /^[a-z][a-z0-9_]{0,62}$/u.test(target ?? '')) {
    if (names.includes(template)) {
      const started = performance.now();
      const via = await copy(target ?? '');
      const cloneMs = Math.round(performance.now() - started);
      console.log(JSON.stringify({ database: target, template, key, via, cloneMs }));
    } else {
      console.error(
        `fixture: SNAPSHOT_STALE, no ${template}; stale: ${stale.join(', ') || 'none'}`,
      );
      process.exitCode = 2;
    }
  } else {
    console.error('usage: fixture-snapshot.sh build | clone <database>');
    process.exitCode = 2;
  }
} finally {
  await server.close();
}
