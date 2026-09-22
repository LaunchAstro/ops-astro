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
// They are skipped, loudly, when Docker is not available, because a probe
// that silently passes without a database would be the exact failure the
// runner refuses. `pnpm db:cases` prints why it skipped and exits 0; CI runs
// with a service container, where the skip cannot trigger.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const runner = join(repoRoot, 'scripts/db-conformance.mjs');

const IMAGE = 'postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

const docker = (...args) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

const dockerUp = () => docker('info', '--format', '{{.ServerVersion}}').status === 0;

/** A throwaway Postgres, removed however this ends. */
function withDatabase(run) {
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

const skipUnlessDocker = (t) => {
  if (dockerUp()) return false;
  console.error(
    'db-conformance cases: Docker is not available, so these probes did not run.\n' +
      'db-conformance cases: they need a real database. In CI the service\n' +
      'db-conformance cases: container supplies one and this branch cannot be taken.',
  );
  t.skip('Docker is not available');
  return true;
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

test('no DATABASE_URL is a refusal, not a skip', () => {
  const run = spawnSync(process.execPath, [runner], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });
  assert.equal(run.status, 2, `expected exit 2, got ${String(run.status)}`);
  assert.match(run.stderr, /DATABASE_URL must be set/u);
});
