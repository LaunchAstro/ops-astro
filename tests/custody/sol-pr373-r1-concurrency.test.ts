// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ active: 0, maximum: 0 }));

// Count callbacks only after a real transaction has obtained its connection.
// The original database and every query remain unchanged.
vi.mock('../../packages/core-records/src/tenancy/database.ts', async (original) => {
  const actual =
    await original<typeof import('../../packages/core-records/src/tenancy/database.ts')>();
  const connect: typeof actual.connect = (url, options) => {
    const database = actual.connect(url, options);
    if (!new URL(url).pathname.startsWith('/t1_c31_')) return database;
    return {
      ...database,
      withBusiness: async (business, run) =>
        await database.withBusiness(business, async (tx) => {
          const measured =
            expect.getState().currentTestName?.includes('C31 two setters at once') === true;
          if (!measured) return await run(tx);
          observed.active += 1;
          observed.maximum = Math.max(observed.maximum, observed.active);
          try {
            return await run(tx);
          } finally {
            observed.active -= 1;
          }
        }),
    };
  };
  return { ...actual, connect };
});

// Execute the PR's exact named tests, including its two-setters race test.
import './c31-credentials.test.ts';

it('Sol proof, criterion 7: the named two-setters test must overlap real database transactions', () => {
  expect(
    observed.maximum,
    'The named race test used only one active transaction, so it cannot expose an insert race',
  ).toBeGreaterThanOrEqual(2);
});
