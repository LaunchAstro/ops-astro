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
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { seedFixture } from './generate.ts';
import { FIXTURE_SHAPE } from './shape.ts';

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
 * a dump and restore inside the local server's container (RN-09). Names go
 * in as positional arguments, never into the shell text.
 */
async function copy(target: string): Promise<string> {
  try {
    await server.execute(`create database "${target}" template "${template}"`);
    return 'template';
  } catch (error) {
    if ((error as { code?: string }).code !== '55006') throw error;
  }
  const user = decodeURIComponent(new URL(serverUrl).username);
  const container = process.env['FIXTURE_PG_CONTAINER'] ?? 'ops-astro-local-pg';
  const script =
    'createdb -U "$1" -T template0 "$3" && pg_dump -U "$1" -Fc "$2" | pg_restore -U "$1" -d "$3"';
  const args = ['exec', container, 'sh', '-c', script, 'copy', user, template, target];
  const run = spawnSync('docker', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (run.status !== 0) throw new Error(`fixture: dump and restore failed (${String(run.status)})`);
  return 'dump-restore';
}
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
