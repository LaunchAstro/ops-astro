// SPDX-License-Identifier: AGPL-3.0-only
// Item 6: the database gate, proved against a real database.
//
// These probes start a throwaway Postgres container, run controlled fixture
// suites through scripts/db-conformance.mjs against it, and remove the
// container afterwards. Nothing here touches a real database, a real
// credential or a real suite: the password is generated per run and lives as
// long as the container does.
//
// The four things being proved are the four the runner exists for. A fixture
// suite that reaches the database passes. A fixture suite with a skipped
// database test fails. A manifest naming a suite that is not there fails. A
// run in which zero database tests executed fails. There is a fifth, because
// it is the one a reader will not think of: a suite that passes without
// touching the database at all fails too.
//
// Two more were found by running the runner adversarially rather than by
// reading it, and both were green before they were cases. A manifest can name
// a file that exists on disk but sits outside vitest's discovery: it is never
// loaded, its siblings supply the test counts, and the aggregate looks whole.
// And vitest can end a run in failure while every test it counted passed --
// an unhandled rejection does exactly that -- so no count moves and only the
// process exit status says anything is wrong.
//
// They are skipped, loudly, when Docker is not available and this is not CI,
// because a probe that silently passes without a database would be the exact
// failure the runner refuses. Locally `pnpm db:cases` prints why it skipped
// and exits 0.
//
// In CI it refuses instead. Round nine, 23 September, found that with Docker
// inaccessible and CI set, eight of these probes skipped and the command
// still exited 0, so the `database conformance gate` job could report green
// without exercising a single line of database enforcement. A skip is exactly
// what this file exists to refuse, and a skip of the whole file is the
// largest one available. CI supplies the service container; if it is not
// there, that is a broken job, not a passing one.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const runner = join(repoRoot, 'scripts/db-conformance.mjs');

const IMAGE = 'postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

const docker = (...args) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

const dockerUp = () => docker('info', '--format', '{{.ServerVersion}}').status === 0;

// A database the caller already runs, named here, is used instead of a new
// container for each probe, so a lane holding a fixed port stays on it.
const givenUrl = process.env['DB_CONFORMANCE_CASES_URL'] ?? '';

/** A throwaway Postgres, removed however this ends. */
function withDatabase(run) {
  if (givenUrl !== '') return run(givenUrl);
  const password = randomBytes(18).toString('hex');
  const name = `hub-db-conformance-${randomBytes(6).toString('hex')}`;
  const started = docker(
    'run',
    '--rm',
    '--detach',
    '--name',
    name,
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=conformance',
    '--publish',
    '0:5432',
    IMAGE,
  );
  assert.equal(started.status, 0, `could not start Postgres: ${started.stderr}`);
  try {
    const port = docker('port', name, '5432/tcp').stdout.trim().split(':').pop();
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/conformance`;

    // Wait for it to accept connections rather than sleeping a fixed time.
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready =
        docker('exec', name, 'pg_isready', '-U', 'postgres', '-d', 'conformance').status === 0;
      if (!ready) execFileSync('sleep', ['1']);
    }
    assert.ok(ready, 'Postgres never became ready');
    return run(url);
  } finally {
    docker('rm', '--force', name);
  }
}

/** A disposable manifest and suite tree under the repository, so vitest resolves. */
function withSuites(files, manifest, run) {
  const dir = mkdtempSync(join(repoRoot, 'tests/db/tmp-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
    }
    const rel = (p) => join('tests/db', dir.split('tests/db/')[1], p);
    const manifestPath = join(dir, 'named-suites.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        invariant: (manifest.invariant ?? []).map(rel),
        conformance: (manifest.conformance ?? []).map(rel),
      }),
    );
    return run(manifestPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cruise = (manifestPath, url) =>
  spawnSync(process.execPath, [runner, '--manifest', manifestPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
    maxBuffer: 32 * 1024 * 1024,
  });

const REACHES_DATABASE = `// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import pg from 'pg';

test('the database answers', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query('select 1 as one');
    expect(rows[0].one).toBe(1);
  } finally {
    await client.end();
  }
});
`;

const SKIPS_A_DATABASE_TEST = `// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import pg from 'pg';

test('the database answers', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query('select 1 as one');
    expect(rows[0].one).toBe(1);
  } finally {
    await client.end();
  }
});

test.skip('the tenancy invariant holds', async () => {
  expect(true).toBe(true);
});
`;

const NO_TESTS_AT_ALL = `// SPDX-License-Identifier: AGPL-3.0-only
// A suite file with no test in it. It passes every summary that counts
// failures, and proves nothing.
export const nothing = true;
`;

const NEVER_TOUCHES_THE_DATABASE = `// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';

test('a database test with its database assertions gone', () => {
  expect(1 + 1).toBe(2);
});
`;

// Exists on disk, throws the moment it is loaded, and is not a `.test.ts`, so
// vitest's discovery never picks it up however loudly the manifest names it.
const NAMED_BUT_UNDISCOVERED = `// SPDX-License-Identifier: AGPL-3.0-only
throw new Error('this named suite must not be ignored');
`;

const UNHANDLED_REJECTION = `// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import pg from 'pg';

test('the database answers', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query('select 1 as one');
    expect(rows[0].one).toBe(1);
  } finally {
    await client.end();
  }
});

test('a passing test beside an unhandled rejection', async () => {
  Promise.reject(new Error('intentional unhandled probe'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(true).toBe(true);
});
`;

/** CI's own flag, read the way every runner sets it: present and not false. */
const inCI = () => {
  const value = (process.env['CI'] ?? '').trim().toLowerCase();
  return value !== '' && value !== 'false' && value !== '0';
};

// A nested run of this file, used by the two probes below to observe what a
// run without Docker does. It must not recurse into them.
const isChild = (process.env['DB_CONFORMANCE_CASES_CHILD'] ?? '') !== '';

const skipUnlessDocker = (t) => {
  if (givenUrl !== '' || dockerUp()) return false;
  if (inCI()) {
    // Not t.skip. In CI a skip here is the green this file refuses.
    assert.fail(
      'Docker is not available and CI is set, so no database could be started. ' +
        'These probes prove the database gate, and a skipped probe proves nothing: ' +
        'the `database conformance gate` job must supply a Postgres service ' +
        'container. Refusing rather than skipping.',
    );
  }
  console.error(
    'db-conformance cases: Docker is not available, so these probes did not run.\n' +
      'db-conformance cases: they need a real database. In CI this is a refusal,\n' +
      'db-conformance cases: not a skip, because the service container supplies one.',
  );
  t.skip('Docker is not available');
  return true;
};

/**
 * This same file, run again with Docker out of reach: PATH is an empty
 * directory, so the docker binary is not found however the host is set up.
 */
const withoutDocker = (ci) => {
  const empty = mkdtempSync(join(tmpdir(), 'hub-db-cases-nopath-'));
  const env = { ...process.env, PATH: empty, DB_CONFORMANCE_CASES_CHILD: '1' };
  delete env['DB_CONFORMANCE_CASES_URL'];
  if (ci) env['CI'] = 'true';
  else delete env['CI'];
  try {
    return spawnSync(process.execPath, [resolve(import.meta.filename)], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
};

test('a fixture suite that reaches the database passes', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites({ 'reaches.test.ts': REACHES_DATABASE }, { invariant: ['reaches.test.ts'] }, (m) => {
      const run = cruise(m, url);
      assert.equal(run.status, 0, `expected exit 0, got ${String(run.status)}: ${run.stderr}`);
      assert.match(run.stdout, /1 test\(s\): 1 passed/u);
      assert.match(run.stdout, /none of them skipped/u);
    }),
  );
});

test('a fixture suite with a skipped database test fails', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      { 'skips.test.ts': SKIPS_A_DATABASE_TEST },
      { invariant: ['skips.test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}`);
        assert.match(run.stderr, /database test\(s\) were skipped/u);
        assert.match(run.stderr, /the tenancy invariant holds/u);
      },
    ),
  );
});

test('a named suite that is not on disk fails', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites({ 'present.test.ts': REACHES_DATABASE }, { invariant: ['present.test.ts'] }, (m) => {
      const broken = `${m}.broken.json`;
      writeFileSync(broken, JSON.stringify({ invariant: ['tests/db/no-such-suite.test.ts'] }));
      try {
        const run = cruise(broken, url);
        assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}`);
        assert.match(run.stderr, /names suites that are not on disk/u);
        assert.match(run.stderr, /no-such-suite/u);
      } finally {
        rmSync(broken, { force: true });
      }
    }),
  );
});

test('zero database tests fails', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites({ 'empty.test.ts': NO_TESTS_AT_ALL }, { invariant: ['empty.test.ts'] }, (m) => {
      const run = cruise(m, url);
      assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}`);
      assert.match(run.stderr, /zero tests executed|no readable result/u);
    }),
  );
});

test('a suite that passes without touching the database fails', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      { 'beside.test.ts': NEVER_TOUCHES_THE_DATABASE },
      { invariant: ['beside.test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stdout}`);
        assert.match(run.stderr, /without the database recording a single transaction/u);
      },
    ),
  );
});

test('a named suite vitest never discovered fails', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      { 'reaches.test.ts': REACHES_DATABASE, 'not-a-test.ts': NAMED_BUT_UNDISCOVERED },
      { invariant: ['reaches.test.ts'], conformance: ['not-a-test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stdout}`);
        assert.match(run.stderr, /cannot be bound to a result/u);
        assert.match(run.stderr, /not-a-test\.ts/u);
        assert.match(run.stderr, /vitest never reported this file/u);
      },
    ),
  );
});

test('a run vitest itself reported as failed fails', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      { 'unhandled.test.ts': UNHANDLED_REJECTION },
      { invariant: ['unhandled.test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stdout}`);
        // Every counted test passed, so only vitest's own verdict shows it.
        assert.match(run.stdout, /2 passed, 0 failed/u);
        assert.match(run.stderr, /vitest reported the run as failed/u);
        assert.match(run.stderr, /vitest exited with status 1/u);
      },
    ),
  );
});

test('an empty manifest fails rather than passing vacuously', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites({}, {}, (m) => {
      const run = cruise(m, url);
      assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}`);
      assert.match(run.stderr, /names no suite/u);
    }),
  );
});

// Round nine, 23 September. Finding 3: the transaction counter was a
// whole-run number, so a named suite holding no database call at all passed
// on a sibling's transactions. The pair is two suites in one manifest.
test('a suite that reaches the database does not cover its sibling', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      { 'reaches.test.ts': REACHES_DATABASE, 'beside.test.ts': NEVER_TOUCHES_THE_DATABASE },
      { invariant: ['reaches.test.ts'], conformance: ['beside.test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stdout}`);
        assert.match(run.stderr, /without the database recording a single transaction/u);
        // The failure names the suite, not the run.
        assert.match(run.stderr, /beside\.test\.ts/u);
        assert.doesNotMatch(run.stderr.split('single transaction')[1] ?? '', /reaches\.test\.ts/u);
      },
    ),
  );
});

test('two suites that each reach the database pass together', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      { 'first.test.ts': REACHES_DATABASE, 'second.test.ts': REACHES_DATABASE },
      { invariant: ['first.test.ts'], conformance: ['second.test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 0, `expected exit 0, got ${String(run.status)}: ${run.stderr}`);
        assert.match(run.stdout, /2 named suite\(s\), 2 test\(s\): 2 passed/u);
        assert.match(run.stdout, /none of them skipped/u);
      },
    ),
  );
});

// Round ten, 24 September. vitest reads a path as a substring filter, so
// naming `invariant.test.ts` also ran `invariant.test.ts.db.test.ts`, and a
// named suite that never reached the database passed on its sibling's
// transactions and test count.
test('a named suite runs alone, not with a sibling its name prefixes', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      {
        'invariant.test.ts': NEVER_TOUCHES_THE_DATABASE,
        'invariant.test.ts.db.test.ts': REACHES_DATABASE,
      },
      { invariant: ['invariant.test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stdout}`);
        assert.match(run.stderr, /without the database recording a single transaction/u);
      },
    ),
  );
});

test('a named suite that reaches the database passes alone, sibling uncounted', async (t) => {
  if (skipUnlessDocker(t)) return;
  withDatabase((url) =>
    withSuites(
      { 'reaches.test.ts': REACHES_DATABASE, 'reaches.test.ts.more.test.ts': REACHES_DATABASE },
      { invariant: ['reaches.test.ts'] },
      (m) => {
        const run = cruise(m, url);
        assert.equal(run.status, 0, `expected exit 0, got ${String(run.status)}: ${run.stderr}`);
        assert.match(run.stdout, /1 named suite\(s\), 1 test\(s\): 1 passed/u);
      },
    ),
  );
});

// Finding 4: with Docker out of reach these probes skipped and the command
// exited 0, so the hosted job could go green over eight probes that never
// ran. In CI that is now a refusal; locally it is still a skip.
test('with no database and CI set, this file refuses instead of skipping', (t) => {
  if (isChild) {
    t.skip('the nested run is the observation, not the observer');
    return;
  }
  const run = withoutDocker(true);
  assert.notEqual(run.status, 0, `expected a non-zero exit, got ${String(run.status)}`);
  const output = run.stdout + run.stderr;
  assert.match(output, /Docker is not available and CI is set/u);
  assert.match(output, /no database could be started/u);
  assert.doesNotMatch(output, /# skip/u);
});

test('with no database and CI unset, this file still skips locally', (t) => {
  if (isChild) {
    t.skip('the nested run is the observation, not the observer');
    return;
  }
  const run = withoutDocker(false);
  assert.equal(run.status, 0, `expected exit 0, got ${String(run.status)}: ${run.stderr}`);
  assert.match(run.stdout + run.stderr, /Docker is not available, so these probes did not run/u);
});

test('no DATABASE_URL is a refusal, not a skip', () => {
  const run = spawnSync(process.execPath, [runner], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });
  assert.equal(run.status, 2, `expected exit 2, got ${String(run.status)}`);
  assert.match(run.stderr, /DATABASE_URL must be set/u);
});
