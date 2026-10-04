// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Copies the reviewed test unchanged, with test-only instrumentation before it.
// Both generated files are removed even when a proof fails.
export function runSuite(label, prelude, suffix, pattern) {
  assert.ok(process.env.DATABASE_URL, 'Run this proof through solm5.sh with Postgres');
  const suite = fileURLToPath(new URL(`api-2-quota-mutant-${label}.test.ts`, import.meta.url));
  const report = `${suite}.json`;
  const source = readFileSync(new URL('./api-2-agent-credential-quota.test.ts', import.meta.url), 'utf8');
  try {
    writeFileSync(suite, `${prelude}\n${source}\n${suffix}`);
    const child = spawnSync('corepack', [
      'pnpm', 'exec', 'vitest', 'run', suite,
      '--testNamePattern', pattern, '--reporter=json', `--outputFile=${report}`,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 });
    assert.ifError(child.error);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    const cases = result.testResults.flatMap((file) => file.assertionResults);
    for (const one of cases.filter((item) => ['passed', 'failed'].includes(item.status))) {
      console.log(`${one.status}: ${one.fullName}`);
      for (const failure of one.failureMessages) console.log(failure);
    }
    return { child, cases, result };
  } finally {
    rmSync(suite, { force: true });
    rmSync(report, { force: true });
  }
}
