// SPDX-License-Identifier: AGPL-3.0-only
//
// T2b's invariant `worker_boundary` (split section 1.2), its structural half.
//
// The worker holds no database privilege because it never connects: its entry
// point's import graph reaches no database module, no `postgres` or `pg`
// driver, and no text naming `DATABASE_URL` (spike RN-04). The shipped graph
// cannot reach the declining fixture reporter, and, as its own negative case,
// the test build can. The cruiser rules that hold both in CI are planted
// against here so a rule that stops firing goes red.
//
// The process half, a real worker process proposing through a served API, is
// `tests/api/t2b-worker.test.ts`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECLINING_REPORTER } from '../support/declining-reporter.ts';
import { runWorker } from '../api/t2b-support.ts';
import { cruise, importGraph, ROOT } from '../support/import-graph.ts';

const WORKER_ENTRY = 'apps/worker/main.ts';
const FIXTURE_REPORTER = 'tests/support/declining-reporter.ts';

/** Its one transport to the API, and the password grant to the sign-in service, never the API. */
const FETCHES = new Set(['apps/cli/client.ts', 'apps/web/src/session/password-grant.ts']);

describe('worker_boundary: the structure', () => {
  it('the worker entry exists and is its own process entry', () => {
    expect(existsSync(join(ROOT, WORKER_ENTRY))).toBe(true);
    expect(readFileSync(join(ROOT, WORKER_ENTRY), 'utf8')).toMatch(/import\.meta\.main/u);
  });

  it('starts with no delegation only to refuse, naming the missing setting', async () => {
    const refused = await runWorker({ OPS_ASTRO_BUSINESS: 'alpha', OPS_ASTRO_TOKEN: 'a-bearer' });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('OPS_ASTRO_DELEGATION');
  });

  it('reaches no database module and no postgres driver', () => {
    const { files, packages } = importGraph(WORKER_ENTRY);
    const database = [...files].filter((file) =>
      /^packages\/core-(records|runtime|commands)\//u.test(file),
    );
    expect(database).toStrictEqual([]);
    expect([...packages].filter((name) => /^(postgres|pg)(\/|$)/u.test(name))).toStrictEqual([]);
  });

  it('neither reads nor requires DATABASE_URL', () => {
    const { files } = importGraph(WORKER_ENTRY);
    const naming = [...files].filter((file) =>
      readFileSync(join(ROOT, file), 'utf8').includes('DATABASE_URL'),
    );
    expect(naming).toStrictEqual([]);
  });

  it('builds its transport on the command line’s agent entry, not a second client', () => {
    const { files } = importGraph(WORKER_ENTRY);
    expect(files.has('apps/cli/client.ts')).toBe(true);
    const fetches = [...files].filter(
      (file) => !FETCHES.has(file) && /\bfetch\(/u.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(fetches).toStrictEqual([]);
    expect(files.has('apps/web/src/operations/client.ts')).toBe(false);
  });

  it('the shipped graph cannot reach the fixture reporter', () => {
    expect(importGraph(WORKER_ENTRY).files.has(FIXTURE_REPORTER)).toBe(false);
  });

  it('the test build can: its own negative case', () => {
    expect(importGraph('tests/worker/worker-boundary.test.ts').files.has(FIXTURE_REPORTER)).toBe(
      true,
    );
    expect(DECLINING_REPORTER.observe({ kind: 'synthetic_comment' })).toBeNull();
  });
});

const REPORTER = 'export const R = { observe: () => null };\n';

const base = {
  [FIXTURE_REPORTER]: REPORTER,
  'packages/core-records/src/index.ts': 'export const records = 1;\n',
};

describe('worker_boundary: the cruiser rules fire', () => {
  it('is green when only a test reaches the fixture reporter', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts': 'export const worker = 1;\n',
      'tests/worker/uses.test.ts': "import { R } from '../support/declining-reporter.ts';\nR;\n",
    });
    expect(answer.output).toContain('the structural rules hold');
    expect(answer.status).toBe(0);
  });

  it('is red when anything shippable imports the fixture reporter', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts': "import { R } from '../../tests/support/declining-reporter.ts';\nR;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('shippable-never-reaches-tests');
  });

  it('is red when a package imports the fixture reporter', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts': 'export const worker = 1;\n',
      'packages/core-records/src/index.ts':
        "import { R } from '../../../tests/support/declining-reporter.ts';\nexport const records = R;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('shippable-never-reaches-tests');
  });

  it('is red when the worker reaches a database package', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts':
        "import { records } from '../../packages/core-records/src/index.ts';\nrecords;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('worker-holds-no-database');
  });
});
