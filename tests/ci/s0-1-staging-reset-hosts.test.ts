// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 staging reset refuses production, the database host alone (REVB1SL01S34
// finding 1): a login naming staging's project is no pass. Only staging's own
// direct host, or Supabase's pooler in Sydney with a one-dot staging login,
// is accepted; everything else is refused before the reset connects.

import { describe, expect, it } from 'vitest';
import { refusalBeforeConnecting } from '../../scripts/ops/staging-reset.ts';

const STAGING = 'abcdefghijklmnopqrst';
const PRODUCTION = 'zyxwvutsrqponmlkjihg';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
const env = (user: string, host: string): Record<string, string> => ({
  STAGING_PROJECT_REF: STAGING,
  PRODUCTION_PROJECT_REF: PRODUCTION,
  DATABASE_ADMIN_URL: `postgres://${user}:example@${host}:5432/postgres`,
  DATABASE_URL: `postgres://runtime.${STAGING}:example@${POOLER}:6543/postgres`,
  GOTRUE_URL: `https://${STAGING}.supabase.co/auth/v1`,
  SUPABASE_SERVICE_KEY: 'example',
  OPS_SEED_DIR: '/private/tmp/staging-reset-hosts',
  OPS_ASTRO_DEPLOYMENTS: '/private/tmp/staging-reset-hosts-records',
});

describe('S0-1 staging reset refuses production: the database host', () => {
  it("accepts staging's direct host and its pooler login in Sydney", () => {
    expect(refusalBeforeConnecting(env('postgres', `db.${STAGING}.supabase.co`), [])).toBe(
      undefined,
    );
    expect(refusalBeforeConnecting(env(`postgres.${STAGING}`, POOLER), [])).toBe(undefined);
    expect(
      refusalBeforeConnecting(
        env(`postgres.${STAGING}`, 'aws-1-ap-southeast-2.pooler.supabase.com'),
        [],
      ),
    ).toBe(undefined);
  });

  it('refuses another host, another region, a look-alike or a two-dot login, whatever the login says', () => {
    for (const [user, host] of [
      [`postgres.${STAGING}`, 'db.example.test'],
      [`postgres.${STAGING}`, '127.0.0.1'],
      [`postgres.${STAGING}`, 'aws-0-us-east-1.pooler.supabase.com'],
      [`postgres.${STAGING}`, `${POOLER}.`],
      [`postgres.${STAGING}`, `${POOLER}.example.test`],
      [`postgres.${STAGING}`, `db.${STAGING}.supabase.co.example.test`],
      [`x.${PRODUCTION}.${STAGING}`, POOLER],
      [`postgres.${PRODUCTION}`, `db.${STAGING}.supabase.co`],
    ])
      expect(refusalBeforeConnecting(env(user!, host!), []), host).toMatch(/^DATABASE_ADMIN_URL /u);
  });
});
