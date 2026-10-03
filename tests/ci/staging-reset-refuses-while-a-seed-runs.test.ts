// SPDX-License-Identifier: AGPL-3.0-only
// The guard admits one seed's tag at a time: a seed holds the seed admission
// lock (`scripts/ops/made-up-only.ts`) for as long as its session runs. A reset
// that installed the guard meanwhile would swap the tag the running seed writes
// under, and the guard would note that seed's own rows as untrusted for good.
// So the reset takes the same lock first, and refuses while a seed holds it.

import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  calls,
  canaryHolds,
  onDatabase,
  quiet,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset refuses, emptying and guarding nothing, while a seed holds the admission lock',
  async () => {
    const env = settings();
    const before = calls.length;
    const result = await onDatabase(async (seed) => {
      await seed.execute(`select pg_advisory_lock(hashtext('ops_astro_made_up seed'))`);
      return await run(env);
    });
    expect(result.status, result.out).toBe(1);
    expect(result.out).toContain('another seed is running on this database');
    expect(result.out).toContain('Nothing was done');
    quiet(result);
    expect(calls.length, 'the admin API is not asked').toBe(before);
    expect(existsSync(env['OPS_SEED_DIR'] ?? '')).toBe(false);
    expect(existsSync(env['OPS_ASTRO_DEPLOYMENTS'] ?? ''), 'a refusal records nothing').toBe(false);
    expect(await canaryHolds()).toBe(true);
    const guard = await onDatabase((admin) =>
      admin.execute<{ held: boolean }>(
        `select to_regnamespace('ops_astro_made_up') is not null as held`,
      ),
    );
    expect(guard[0]?.held, 'no guard was installed').toBe(false);
  },
  180_000,
);
