// SPDX-License-Identifier: AGPL-3.0-only
// The reset must refuse a database host outside staging before connecting.

import { expect, it } from 'vitest';
import { refusalBeforeConnecting } from '../../scripts/ops/staging-reset.ts';

it('staging reset refuses a database host outside staging even when its login claims the staging project', () => {
  const staging = 'abcdefghijklmnopqrst';
  const production = 'zyxwvutsrqponmlkjihg';
  const env = {
    STAGING_PROJECT_REF: staging,
    PRODUCTION_PROJECT_REF: production,
    DATABASE_ADMIN_URL: `postgres://migration.${staging}:example@production-db.example.test/postgres`,
    DATABASE_URL: `postgres://runtime.${staging}:example@aws-0-ap-southeast-2.pooler.supabase.com/postgres`,
    GOTRUE_URL: `https://${staging}.supabase.co/auth/v1`,
    SUPABASE_SERVICE_KEY: 'example',
    OPS_SEED_DIR: '/private/tmp/staging-reset-proof',
  };

  expect(refusalBeforeConnecting(env, [])).toMatch(/DATABASE_ADMIN_URL/u);
});
