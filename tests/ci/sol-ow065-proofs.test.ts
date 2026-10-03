// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { serveTestKeySetApart, signBearer, TEST_ISSUER } from '../support/sign-in.ts';

it('Sol proof, criterion 3: a malformed database address never prints its password', async () => {
  const keys = await serveTestKeySetApart();
  const password = 'sol-ow065-synthetic-password-canary';
  try {
    const token = await signBearer({
      sub: 'sol-ow065-person',
      aud: 'authenticated',
      iss: TEST_ISSUER,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const result = spawnSync(process.execPath, ['scripts/ops/operator.mjs', 'prepare'], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        OPS_ASTRO_TOKEN: token,
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_DEPLOYMENTS: '/unused-sol-ow065-records',
        GOTRUE_URL: TEST_ISSUER,
        SUPABASE_KEY_SET_URL: keys.url,
        DATABASE_ADMIN_URL: `postgres://owner:${password}@127.0.0.1:bad/database`,
        DATABASE_URL: 'postgres://runtime@127.0.0.1:1/unused',
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
  } finally {
    await keys.close();
  }
});
