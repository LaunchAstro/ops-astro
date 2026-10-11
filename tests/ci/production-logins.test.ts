// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's database logins: the same command as staging's, given
// `--production`. It makes the same logins in the same groups, on production's
// project alone: an admin address on staging's project, or on any project but
// production's, is refused before anything connects, as staging's run refuses
// production's. Judged before anything connects.

import { describe, expect, it } from 'vitest';
import {
  LOGINS,
  loginAddresses,
  loginsRefusal,
  projectRefSetting,
} from '../../scripts/ops/staging-logins.ts';

const STAGING = 'abcdefghijabcdefghij';
const PRODUCTION = 'zyxwvutsrqzyxwvutsrq';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
const admin = (ref: string, host = POOLER): string =>
  `postgresql://postgres.${ref}:secret-admin@${host}:5432/postgres?sslmode=require`;

const environment = (overrides: Record<string, string | undefined> = {}) => ({
  STAGING_PROJECT_REF: STAGING,
  PRODUCTION_PROJECT_REF: PRODUCTION,
  DATABASE_ADMIN_URL: admin(PRODUCTION),
  OPS_LOGINS_DIR: '/tmp/not-made-yet',
  ...overrides,
});

describe("production logins: production's project only", () => {
  it('takes either step with --production after it', () => {
    expect(loginsRefusal(environment(), ['before-reset', '--production'])).toBeUndefined();
    expect(loginsRefusal(environment(), ['after-reset', '--production'])).toBeUndefined();
    expect(loginsRefusal(environment(), ['--production'])).toBe(
      'name one step: before-reset or after-reset',
    );
    expect(loginsRefusal(environment(), ['before-reset', '--production', '--production'])).toBe(
      'name one step: before-reset or after-reset',
    );
  });

  it("refuses an admin address on staging's project, or on any project but production's", () => {
    expect(
      loginsRefusal(environment({ DATABASE_ADMIN_URL: admin(STAGING) }), [
        'before-reset',
        '--production',
      ]),
    ).toBe("DATABASE_ADMIN_URL reaches staging's project");
    expect(
      loginsRefusal(environment({ DATABASE_ADMIN_URL: admin('qqqqqqqqqqqqqqqqqqqq') }), [
        'after-reset',
        '--production',
      ]),
    ).toBe("DATABASE_ADMIN_URL is not production's project");
  });

  it("without --production, production's admin address is refused as before", () => {
    expect(loginsRefusal(environment(), ['before-reset'])).toBe(
      "DATABASE_ADMIN_URL reaches production's project",
    );
  });
});

describe("production logins: both references needed, staging's other refusals kept", () => {
  it("needs both project references, and refuses production's being staging's", () => {
    const args = ['before-reset', '--production'];
    expect(loginsRefusal(environment({ PRODUCTION_PROJECT_REF: undefined }), args)).toBe(
      'PRODUCTION_PROJECT_REF is not set',
    );
    expect(loginsRefusal(environment({ STAGING_PROJECT_REF: undefined }), args)).toBe(
      'STAGING_PROJECT_REF is not set',
    );
    expect(loginsRefusal(environment({ STAGING_PROJECT_REF: 'not-a-ref' }), args)).toBe(
      'STAGING_PROJECT_REF is not a project reference',
    );
    expect(loginsRefusal(environment({ PRODUCTION_PROJECT_REF: STAGING }), args)).toBe(
      "PRODUCTION_PROJECT_REF is staging's",
    );
  });

  it("keeps staging's other refusals: the Sydney pooler, TLS, the folder", () => {
    const args = ['before-reset', '--production'];
    expect(
      loginsRefusal(
        environment({ DATABASE_ADMIN_URL: admin(PRODUCTION, `db.${PRODUCTION}.supabase.co`) }),
        args,
      ),
    ).toBe("DATABASE_ADMIN_URL is not Supabase's pooler in Sydney");
    expect(
      loginsRefusal(
        environment({ DATABASE_ADMIN_URL: admin(PRODUCTION).replace('?sslmode=require', '') }),
        args,
      ),
    ).toBe('DATABASE_ADMIN_URL does not require TLS (add ?sslmode=require or stricter)');
    expect(loginsRefusal(environment({ OPS_LOGINS_DIR: '' }), args)).toBe(
      'OPS_LOGINS_DIR is not set',
    );
  });
});

describe('production logins: the same logins and groups as staging', () => {
  it("names each address's login on production's project", () => {
    expect(projectRefSetting(['before-reset', '--production'])).toBe('PRODUCTION_PROJECT_REF');
    expect(projectRefSetting(['before-reset'])).toBe('STAGING_PROJECT_REF');
    const made = [
      ...loginAddresses(admin(PRODUCTION), PRODUCTION, 'before-reset'),
      ...loginAddresses(admin(PRODUCTION), PRODUCTION, 'after-reset'),
    ];
    expect(made.map(({ login }) => login)).toStrictEqual(LOGINS);
    for (const { login, address } of made) {
      const url = new URL(address);
      expect(decodeURIComponent(url.username)).toBe(`${login.role}.${PRODUCTION}`);
      expect(url.hostname).toBe(POOLER);
      expect(url.searchParams.get('sslmode')).toBe('require');
    }
  });
});
