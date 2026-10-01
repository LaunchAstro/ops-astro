// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

describe('forwarder settings', () => {
  it('refuses a malformed database login by name without printing its value', () => {
    const canary = 'made-up-forwarder-login-canary';
    const run = spawnSync(process.execPath, ['scripts/ops/forwarder.mjs', '--once'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_FORWARDER_URL: `not-a-url-${canary}`,
        OPS_ERROR_SINK_DSN: 'https://made-up-key@example.test/7',
        OPS_ENVIRONMENT: 'staging',
      },
      encoding: 'utf8',
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr.includes(canary), 'login canary reached stderr').toBe(false);
    expect(run.stderr.includes('DATABASE_FORWARDER_URL'), 'setting named').toBe(true);
  });
});
