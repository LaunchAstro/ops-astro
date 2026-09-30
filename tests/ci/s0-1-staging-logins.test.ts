// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 staging logins (STAGING-PREP B3). Hosted staging has no container that
// makes the product's logins, so a person makes them with one command, run
// twice: before the reset, the app group the migrations grant to and the
// runtime login in it; after the reset, one login for each group the
// migrations made (the lookup, the backup identity, the outbox forwarder).
// These are the decisions, judged before anything connects.

import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LOGINS,
  loginAddresses,
  loginsRefusal,
  scramVerifier,
  statementsFor,
} from '../../scripts/ops/staging-logins.ts';

const STAGING = 'abcdefghijabcdefghij';
const PRODUCTION = 'zyxwvutsrqzyxwvutsrq';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
const admin = (ref: string, host = POOLER): string =>
  `postgresql://postgres.${ref}:secret-admin@${host}:5432/postgres`;

const environment = (overrides: Record<string, string | undefined> = {}) => ({
  STAGING_PROJECT_REF: STAGING,
  PRODUCTION_PROJECT_REF: PRODUCTION,
  DATABASE_ADMIN_URL: admin(STAGING),
  OPS_LOGINS_DIR: '/tmp/not-made-yet',
  ...overrides,
});

describe('S0-1 staging logins: refused before connecting, by setting name', () => {
  it('takes exactly one step, before-reset or after-reset', () => {
    expect(loginsRefusal(environment(), [])).toBe('name one step: before-reset or after-reset');
    expect(loginsRefusal(environment(), ['now'])).toBe(
      'name one step: before-reset or after-reset',
    );
    expect(loginsRefusal(environment(), ['before-reset', 'after-reset'])).toBe(
      'name one step: before-reset or after-reset',
    );
    expect(loginsRefusal(environment(), ['before-reset'])).toBeUndefined();
    expect(loginsRefusal(environment(), ['after-reset'])).toBeUndefined();
  });

  it("refuses an admin address of another project or of production's", () => {
    expect(
      loginsRefusal(environment({ DATABASE_ADMIN_URL: admin('qqqqqqqqqqqqqqqqqqqq') }), [
        'before-reset',
      ]),
    ).toBe("DATABASE_ADMIN_URL is not staging's project");
    expect(
      loginsRefusal(environment({ DATABASE_ADMIN_URL: admin(PRODUCTION) }), ['before-reset']),
    ).toBe("DATABASE_ADMIN_URL reaches production's project");
    expect(loginsRefusal(environment({ STAGING_PROJECT_REF: PRODUCTION }), ['before-reset'])).toBe(
      "STAGING_PROJECT_REF is production's",
    );
  });

  it('refuses any host but the Sydney pooler, whatever the login says', () => {
    expect(
      loginsRefusal(environment({ DATABASE_ADMIN_URL: admin(STAGING, 'db.example.test') }), [
        'before-reset',
      ]),
    ).toBe('DATABASE_ADMIN_URL is not a staging database host');
    // The direct host is staging's, but the logins' addresses go through the pooler.
    expect(
      loginsRefusal(
        environment({ DATABASE_ADMIN_URL: admin(STAGING, `db.${STAGING}.supabase.co`) }),
        ['before-reset'],
      ),
    ).toBe("DATABASE_ADMIN_URL is not Supabase's pooler in Sydney");
  });
});

describe('S0-1 staging logins: every setting needed, no value named', () => {
  it('needs every setting, and a folder for the new addresses', () => {
    for (const name of ['STAGING_PROJECT_REF', 'DATABASE_ADMIN_URL', 'OPS_LOGINS_DIR']) {
      expect(loginsRefusal(environment({ [name]: undefined }), ['before-reset'])).toBe(
        `${name} is not set`,
      );
    }
  });

  it('names no value in a refusal', () => {
    const refusal =
      loginsRefusal(environment({ DATABASE_ADMIN_URL: admin(PRODUCTION) }), ['before-reset']) ?? '';
    for (const value of [PRODUCTION, STAGING, 'secret-admin', POOLER]) {
      expect(refusal).not.toContain(value);
    }
  });
});

describe('S0-1 staging logins: each login, its one group and its address', () => {
  it('before the reset: the app group and the runtime login in it, inheriting', () => {
    const before = LOGINS.filter((login) => login.step === 'before-reset');
    expect(before.map((login) => [login.setting, login.role, login.group, login.inherit])).toEqual([
      ['DATABASE_URL', 'ops_astro_api', 'ops_astro_app', true],
    ]);
  });

  it('after the reset: lookup, backup identity and forwarder, each only by setting its role', () => {
    const after = LOGINS.filter((login) => login.step === 'after-reset');
    expect(after.map((login) => [login.setting, login.role, login.group, login.inherit])).toEqual([
      ['DATABASE_LOOKUP_URL', 'ops_astro_lookup_login', 'ops_astro_lookup', false],
      ['BACKUP_SOURCE_URL', 'ops_astro_backup_login', 'ops_astro_backup', false],
      ['DATABASE_FORWARDER_URL', 'ops_astro_forwarder_login', 'ops_astro_forwarder', false],
    ]);
  });

  it("gives each address the pooler's <login>.<reference> form, Vercel's on the transaction port", () => {
    const addresses = loginAddresses(admin(STAGING), STAGING, 'after-reset', () => 'pw-1');
    expect(addresses.map(({ login, address }) => [login.setting, address])).toEqual([
      [
        'DATABASE_LOOKUP_URL',
        `postgresql://ops_astro_lookup_login.${STAGING}:pw-1@${POOLER}:6543/postgres`,
      ],
      [
        'BACKUP_SOURCE_URL',
        `postgresql://ops_astro_backup_login.${STAGING}:pw-1@${POOLER}:5432/postgres`,
      ],
      [
        'DATABASE_FORWARDER_URL',
        `postgresql://ops_astro_forwarder_login.${STAGING}:pw-1@${POOLER}:5432/postgres`,
      ],
    ]);
    const [runtime] = loginAddresses(admin(STAGING), STAGING, 'before-reset', () => 'pw-2');
    expect(runtime?.address).toBe(
      `postgresql://ops_astro_api.${STAGING}:pw-2@${POOLER}:6543/postgres`,
    );
  });
});

describe('S0-1 staging logins: a password reaches the database only as a SCRAM verifier', () => {
  it('builds the verifier Postgres checks a SCRAM-SHA-256 sign-in against', () => {
    const salt = Buffer.from('0123456789abcdef');
    const verifier = scramVerifier('pw-3', salt, 4096);
    const salted = pbkdf2Sync('pw-3', salt, 4096, 32, 'sha256');
    const stored = createHash('sha256')
      .update(createHmac('sha256', salted).update('Client Key').digest())
      .digest('base64');
    const server = createHmac('sha256', salted).update('Server Key').digest('base64');
    expect(verifier).toBe(`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`);
  });

  it('never puts the password itself in a statement', () => {
    const addresses = loginAddresses(admin(STAGING), STAGING, 'after-reset', () => 'pw-plain');
    const statements = statementsFor('after-reset', addresses).join('\n');
    expect(statements).not.toContain('pw-plain');
    expect(statements.match(/password 'SCRAM-SHA-256\$4096:/gu)).toHaveLength(3);
  });

  it('makes each login with no power of its own, in its one group', () => {
    const addresses = loginAddresses(admin(STAGING), STAGING, 'after-reset', () => 'pw');
    const statements = statementsFor('after-reset', addresses).join('\n');
    for (const role of ['ops_astro_lookup', 'ops_astro_backup', 'ops_astro_forwarder']) {
      expect(statements).toContain(
        `create role ${role}_login login nosuperuser nocreatedb nocreaterole nobypassrls ` +
          `noreplication noinherit`,
      );
      expect(statements).toContain(`grant ${role} to ${role}_login`);
    }
    const before = statementsFor(
      'before-reset',
      loginAddresses(admin(STAGING), STAGING, 'before-reset', () => 'pw'),
    ).join('\n');
    expect(before).toContain('create role ops_astro_app nologin');
    expect(before).toContain(
      'create role ops_astro_api login nosuperuser nocreatedb nocreaterole nobypassrls ' +
        'noreplication inherit',
    );
    expect(before).toContain('grant ops_astro_app to ops_astro_api');
    expect(before).toContain("format('revoke temporary on database %I from public'");
  });
});
