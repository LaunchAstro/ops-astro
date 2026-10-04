// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSuite } from './api-2-quota-mutant-suite.mjs';

test('the held-call cases wait for admission rather than 300 milliseconds', () => {
  const prelude = `
import { vi } from 'vitest';
vi.mock('./api-2-agent-credential-use-world.ts', async (original) => {
  const real = await original<typeof import('./api-2-agent-credential-use-world.ts')>();
  return {
    ...real,
    comment: async (...args: Parameters<typeof real.comment>) => {
      // Only delay test setup. The API, database and quota are unchanged.
      await new Promise<void>((resolve) => { setTimeout(resolve, 900); });
      return await real.comment(...args);
    },
  };
});
`;
  const { child, cases } = runSuite('slow-admission', prelude, '', 'API-2 quota in flight per');
  const selected = cases.filter((one) => ['passed', 'failed'].includes(one.status));
  assert.equal(selected.length, 3, 'All three in-flight cases must run');
  assert.equal(
    child.status,
    0,
    'A 900 ms setup delay lets the probe read before the held comment enters its slot; the healthy limiter is reported broken',
  );
});
