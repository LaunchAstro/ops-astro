// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('the business mutation proof requires both named cases to catch interference', () => {
  const source = new URL('./api-2-agent-credential-quota.test.ts', import.meta.url);
  const original = readFileSync(source, 'utf8');
  const assertion =
    "expect((await readInBravo(api, beas)).code, 'another business is outside it').toBe('ok');";
  assert.equal(
    original.split(assertion).length,
    2,
    'Remove exactly the export isolation assertion',
  );
  try {
    writeFileSync(source, original.replace(assertion, 'await readInBravo(api, beas);'));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        'tests/api/api-2-quota-cases-catch-cross-business-throttle.test.mjs',
      ],
      { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 },
    );
    assert.ifError(child.error);
    console.log(child.stdout);
    console.log(child.stderr);
    assert.match(
      child.stdout,
      /passed: API-2 quota on export per business/u,
      'The weakened export case misses the demonstrated fault',
    );
    assert.match(
      child.stdout,
      /failed: API-2 quota in flight per business/u,
      'The other case still detects its fault',
    );
    assert.match(
      child.stdout,
      /passed: Sol mutant witness: Alpha exports incorrectly refuse Bravo/u,
      'The API witness confirms export interference',
    );
    assert.notEqual(
      child.status,
      0,
      'The proof must reject an export case that misses business interference even when the in-flight case fails',
    );
  } finally {
    writeFileSync(source, original);
  }
});
