// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PARTS, onOwnCluster, openScratch, revertPart } from './self-test/mutations.ts';

// A part's unwire may turn red only the later parts built on its code, the
// ones it declares as `dependents` in parts.json (T3d1 reconciles the steps
// T3b's sweep holds unknown). Every other part's suite stays at its head
// counts: no new failure, no new skip. Local and slow (every part's suite,
// at the head and under each unwire); the catalogue test checks in CI that
// each declared dependent reaches code the part added. T3d2 runs its own
// process-control proofs, not a suite, and is left out here.

const suiteParts = PARTS.filter((part) => part.planted === undefined && part.id !== 'T3d2');

/** Failed and skipped cases per part, from one vitest JSON report per part. */
function counts(scratch) {
  const out = join(scratch.dir, '.local', 'dependents.json');
  const by = new Map();
  for (const part of suiteParts) {
    rmSync(out, { force: true });
    spawnSync(
      join(scratch.dir, 'node_modules/.bin/vitest'),
      ['run', '--reporter=json', `--outputFile=${out}`, ...part.files],
      { cwd: scratch.dir, env: process.env, encoding: 'utf8', timeout: 900_000 },
    );
    const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
    by.set(part.id, {
      failed: report === undefined ? 1 : report.numFailedTests + report.numFailedTestSuites,
      skipped: report === undefined ? 0 : report.numPendingTests + report.numTodoTests,
    });
  }
  return by;
}

test('under each unwired part, exactly its declared dependents go red or skip', () => {
  const container = process.env.FIXTURE_PG_CONTAINER;
  assert.ok(container, 'use an isolated Postgres container');
  const published = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' });
  for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
    assert.ok(onOwnCluster(process.env[name] ?? '', published), `${name} must use that container`);
  }

  const scratch = openScratch();
  try {
    const install = spawnSync('corepack', ['pnpm', 'install', '--offline', '--frozen-lockfile'], {
      cwd: scratch.dir,
      encoding: 'utf8',
    });
    assert.equal(install.status, 0, install.stderr);
    const head = counts(scratch);
    for (const [id, one] of head) assert.equal(one.failed, 0, `${id} must pass at the head`);

    for (const part of PARTS.filter((one) => (one.unwire ?? []).length > 0)) {
      assert.equal(revertPart(scratch, part, true).applied, true);
      const under = counts(scratch);
      const moved = [...under]
        .filter(
          ([id, one]) => id !== part.id && (one.failed > 0 || one.skipped > head.get(id).skipped),
        )
        .map(([id]) => id);
      const declared = (part.dependents ?? []).map((one) => one.part);
      assert.deepEqual(
        {
          undeclared: moved.filter((id) => !declared.includes(id)),
          stayedGreen: declared.filter((id) => !moved.includes(id)),
        },
        { undeclared: [], stayedGreen: [] },
        `${part.id}'s unwire: the parts that go red or skip must be exactly its declared dependents`,
      );
    }
  } finally {
    scratch.close();
  }
});
