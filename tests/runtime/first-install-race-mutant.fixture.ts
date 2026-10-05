// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';

// Test-only mutation: remove the reader's install lock. Keep all reads,
// writes and assertions of the committed test, against the real database.
vi.mock('../../packages/core-records/src/records/business-settings.ts', async (original) => {
  const actual =
    await original<typeof import('../../packages/core-records/src/records/business-settings.ts')>();
  return { ...actual, lockSettingsInstall: () => Promise.resolve() };
});

// A rival connection can be delayed before it reaches the server. Its work
// starts after the committed test's timeout, so there is no overlap to prove.
vi.mock('./schedules-harness.ts', async (original) => {
  const actual = await original<typeof import('./schedules-harness.ts')>();
  return {
    ...actual,
    racer: (...args: Parameters<typeof actual.racer>) => {
      const database = actual.racer(...args);
      return {
        ...database,
        withBusiness: async <T>(
          business: string,
          run: Parameters<typeof database.withBusiness<T>>[1],
        ): Promise<T> => {
          await new Promise((resolve) => {
            setTimeout(resolve, Number(process.env['RACE_MUTANT_RIVAL_DELAY'] ?? '6000'));
          });
          return await database.withBusiness(business, run);
        },
      };
    },
  };
});

if (process.env['RACE_MUTANT_SUITE'] === 'launch') {
  await import('./launch-gate-first-sign-off-setting-race.test.ts');
} else {
  await import('./four-eyes-threshold-first-install-race.test.ts');
}
