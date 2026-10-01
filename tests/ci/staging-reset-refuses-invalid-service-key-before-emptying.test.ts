// SPDX-License-Identifier: AGPL-3.0-only
// A rejected service key must not leave an emptied database with no reset record.

import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  canaryHolds,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset refuses an invalid service key before emptying the database',
  async () => {
    const env = settings({ SUPABASE_SERVICE_KEY: 'invalid-service-key' });
    const result = await run(env);

    expect(result.status).toBe(1);
    expect(result.out).not.toContain('invalid-service-key');
    expect(existsSync(env['OPS_ASTRO_DEPLOYMENTS'] ?? '')).toBe(false);
    expect(await canaryHolds()).toBe(true);
  },
  180_000,
);
