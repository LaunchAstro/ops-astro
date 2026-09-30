// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-7: CI tests on the hosted database's major. The hosted database runs
// Postgres 17 (LF-3), so the required database jobs, the local database, the
// restart proof and the local auth stack run the one 17 image staging runs,
// by digest, and a Postgres 18 job runs beside them as a look-ahead that is
// not required. Each case is named after a line of the ticket.

import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const staging = JSON.parse(read('deploy/staging/compose.json')) as {
  'x-ops-astro': { productionDatabaseMajor: number };
  services: { backups: { image: string } };
};
const PRODUCTION_MAJOR = staging['x-ops-astro'].productionDatabaseMajor;
/** The one 17 digest: the image staging's backup store runs, which production's major decides. */
const DIGEST = /@sha256:([0-9a-f]{64})$/u.exec(staging.services.backups.image)?.[1] ?? '';
/** The look-ahead job names its own major; every other run expects production's. */
const LOOKAHEAD = 'OPS_ASTRO_DB_LOOKAHEAD_MAJOR';

/** Every job under `jobs:` in ci.yml, keyed by its id. */
function jobs(): Map<string, string> {
  const text = read('.github/workflows/ci.yml');
  const body = text.slice(text.search(/^jobs:$/mu));
  const parts = body.split(/^(?= {2}[\w-]+:$)/mu).slice(1);
  return new Map(parts.map((block) => [block.trim().split(':')[0] ?? '', block]));
}
/** The job whose check name is `name`. */
const job = (name: string) =>
  [...jobs().values()].find((b) => b.includes(`\n    name: ${name}\n`)) ?? '';
/** Every `image:` a block names, comments dropped. */
const images = (block: string) =>
  [...block.matchAll(/^\s*image: *(\S+)/gmu)].map((m) => m[1] ?? '');
/** The values a shell script assigns to `name`, one per line it is set on. */
function assigned(path: string, name: string): string[] {
  return [...read(path).matchAll(/^(\w+)=(\S+)$/gmu)].flatMap((m) =>
    m[1] === name ? [m[2] ?? ''] : [],
  );
}
const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string }[];
  }
).required_status_checks.map((c) => c.context);

const LOOKAHEAD_JOB = 'database look-ahead, Postgres 18 (not required)';
/** The shards the required `database conformance` check rolls up (#252). */
const SHARD_JOB = 'database conformance shard ${{ matrix.shard }}';

describe('S0-7 CI on the hosted major', () => {
  ciOnTheCases1();
  ciOnTheCases2();
});

function ciOnTheCases1() {
  it('production major and the digest are stated once, in staging', () => {
    expect(PRODUCTION_MAJOR).toBe(17);
    expect(staging.services.backups.image).toMatch(/^postgres:17-alpine@sha256:[0-9a-f]{64}$/u);
    expect(DIGEST).toHaveLength(64);
  });

  it('S0-7 the four places name the same 17 digest', () => {
    const want = `postgres@sha256:${DIGEST}`;
    const places = {
      'ci.yml database conformance': images(job(SHARD_JOB)),
      'ci.yml isolation tests': images(job('isolation tests')),
      'scripts/local/db-up.sh': assigned('scripts/local/db-up.sh', 'IMAGE'),
      'scripts/local/restart-proof.sh': assigned('scripts/local/restart-proof.sh', 'IMAGE'),
      'scripts/local/auth-up.sh': assigned('scripts/local/auth-up.sh', 'PG_IMAGE'),
    };
    expect(places).toStrictEqual({
      'ci.yml database conformance': [want],
      'ci.yml isolation tests': [want],
      'scripts/local/db-up.sh': [want],
      'scripts/local/restart-proof.sh': [want],
      'scripts/local/auth-up.sh': [want],
    });
    // The pins record says which tag the digest was read from.
    expect(read('docs/supply-chain-pins.md')).toMatch(
      new RegExp(`\\| \`postgres\` +\\| \`17-alpine\` +\\| \`sha256:${DIGEST}\` \\|`, 'u'),
    );
  });

  it('S0-7 the required database-conformance job runs Postgres 17 by digest and fails on any skip', () => {
    const block = job(SHARD_JOB);
    expect(required).toContain('database conformance');
    // The required check passes only when every shard did.
    expect(job('database conformance')).toMatch(/^ {4}needs: \[database-shard\]$/mu);
    expect(required).toContain('isolation tests');
    expect(images(block)).toStrictEqual([`postgres@sha256:${DIGEST}`]);
    // The runner it calls is the one that fails a run with a skipped test
    // (tests/ci/db-conformance-cases.mjs holds that to cases).
    expect(block).toMatch(
      /^ {6}- run: pnpm run db:conformance --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}$/mu,
    );
    expect(read('scripts/db-conformance.mjs')).toMatch(/A skip is the failure/u);
    // The required jobs never ask for another major.
    for (const name of ['database conformance', SHARD_JOB, 'isolation tests']) {
      expect(job(name), name).not.toContain(LOOKAHEAD);
      expect(job(name), name).not.toMatch(/continue-on-error/u);
    }
  });
}

function ciOnTheCases2() {
  it('S0-7 a Postgres 18 look-ahead runs on every pull request, not required, its failure reported', () => {
    const block = job(LOOKAHEAD_JOB);
    const pins = read('docs/supply-chain-pins.md');
    const eighteen = /\| `postgres` +\| `18-alpine` +\| `sha256:([0-9a-f]{64})` \|/u.exec(
      pins,
    )?.[1];
    expect(eighteen).toHaveLength(64);
    expect(images(block)).toStrictEqual([`postgres@sha256:${eighteen}`]);
    expect(block).toMatch(new RegExp(`${LOOKAHEAD}: '18'`, 'u'));
    expect(block).toMatch(/^ {6}- run: pnpm run db:conformance$/mu);
    // Every pull request: the workflow runs on them and the job has no condition.
    expect(read('.github/workflows/ci.yml')).toMatch(/^on:\n {2}pull_request:/mu);
    expect(block).not.toMatch(/^ {4}if:/mu);
    // Not required, and nothing required waits on it.
    expect(required).not.toContain(LOOKAHEAD_JOB);
    const id = [...jobs()].find(([, b]) => b === block)?.[0] ?? '';
    for (const other of jobs().values())
      expect(other).not.toMatch(new RegExp(`needs:.*\\b${id}\\b`, 'u'));
    // Its failure shows red on the pull request: nothing turns it green.
    expect(block).not.toMatch(/continue-on-error/u);
  });

  it('S0-7 the watch line: one ticket moves production, staging, CI and the restore drill to 18', () => {
    expect(read('docs/supply-chain-pins.md').replaceAll(/\s+/gu, ' ')).toMatch(
      /When the provider offers Postgres 18, one ticket moves production, staging, CI and the restore drill \(S0-3\) to it together\./u,
    );
  });
}

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) {
  console.warn('S0-7 database cases: DATABASE_URL is unset, so nothing below ran.');
}
const EXPECTED_MAJOR = Number(process.env[LOOKAHEAD] ?? PRODUCTION_MAJOR);

let db: FreshDatabase;

const scratch: string[] = [];

describe.skipIf(serverUrl === undefined)('S0-7 the database under test', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's07' });
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
  });

  theDatabaseUnderCases();
});

function theDatabaseUnderCases() {
  it('runs the major this job names', async () => {
    const [row] = await db.admin.execute<{ n: string }>(
      `select current_setting('server_version_num') as n`,
    );
    expect(Math.floor(Number(row?.n) / 10_000)).toBe(EXPECTED_MAJOR);
  });

  it('S0-7 18-only feature refused: a planted migration calling uuidv7() fails on 17', async () => {
    const directory = mkdtempSync(join(tmpdir(), 's0-7-'));
    scratch.push(directory);
    for (const file of readdirSync(join(ROOT, 'migrations'))) {
      if (file.endsWith('.sql'))
        copyFileSync(join(ROOT, 'migrations', file), join(directory, file));
    }
    writeFileSync(
      join(directory, '9999_planted_uuidv7.sql'),
      'create table public.s0_7_planted (id uuid primary key default uuidv7());\n',
    );
    await db.closeSessions();
    const run = migrate(db.admin, directory);
    const ledger = async () =>
      (
        await db.admin.execute<{ version: string }>(`select version from ops.schema_migrations`)
      ).map((r) => r.version);
    const table = async () =>
      (
        await db.admin.execute<{ t: string | null }>(
          `select to_regclass('public.s0_7_planted')::text as t`,
        )
      )[0]?.t;
    if (EXPECTED_MAJOR < 18) {
      // undefined_function: the server, not a check of ours, refuses it.
      await expect(run).rejects.toMatchObject({ cause: { code: '42883' } });
      expect(await ledger()).not.toContain('9999_planted_uuidv7');
      expect(await table()).toBeNull();
    } else {
      // On 18 the same file applies: the refusal above is the major's, not the file's.
      await expect(run).resolves.toMatchObject({ applied: ['9999_planted_uuidv7'] });
      expect(await table()).toBe('s0_7_planted');
    }
  }, 180_000);
}
