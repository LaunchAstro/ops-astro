// SPDX-License-Identifier: AGPL-3.0-only
// A writable record target that discards bytes cannot audit a reset.

import { mkdirSync, symlinkSync } from 'node:fs';
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
  'staging reset refuses a record target that discards writes before emptying the database',
  async () => {
    const env = settings();
    const records = env['OPS_ASTRO_DEPLOYMENTS'] ?? '';
    mkdirSync(records, { recursive: true });
    symlinkSync('/dev/null', join(records, 'deployments.jsonl'));

    const result = await run(env);

    expect({ status: result.status, canary: await canaryHolds() }).toStrictEqual({
      status: 1,
      canary: true,
    });
  },
  180_000,
);
