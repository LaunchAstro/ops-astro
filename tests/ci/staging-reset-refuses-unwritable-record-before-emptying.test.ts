// SPDX-License-Identifier: AGPL-3.0-only
// A reset that cannot append its record must refuse before clearing staging.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  'staging reset refuses an unwritable deployment record before emptying the database',
  async () => {
    const env = settings();
    const records = env['OPS_ASTRO_DEPLOYMENTS'] ?? '';
    mkdirSync(join(records, 'deployments.jsonl'), { recursive: true });

    const result = await run(env);

    expect(result.status).toBe(1);
    expect(await canaryHolds()).toBe(true);
  },
  180_000,
);
