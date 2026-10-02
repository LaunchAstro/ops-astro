// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5 item 7: the authenticated API scan signs in as a made-up login the job
// makes and removes itself (`scripts/security/scan-login.ts`). These are its
// refusals, decided before anything connects; the local dry run in
// `deploy/staging/SECURITY-SCAN.md` proves the make and remove end to end.

import { expect, it } from 'vitest';
import {
  loginRecord,
  removalRefusal,
  SCAN_BUSINESS,
  SCAN_GRANTS,
  SCAN_PERSON,
  scanEmail,
  scanLoginRefusal,
} from '../../scripts/security/scan-login.ts';

const STAGING = 'abcdefghijklmnopqrst';
const PRODUCTION = 'zyxwvutsrqponmlkjihg';
const pooler = (login: string, ref: string) =>
  `postgresql://${login}.${ref}:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require`;

const staging = (overrides: Record<string, string | undefined> = {}) => ({
  SCAN_LOGIN_PLACE: 'staging',
  SCAN_LOGIN_FILE: '/runner/temp/scan-login.json',
  SCAN_TOKEN_FILE: '/runner/temp/scan-token',
  STAGING_PROJECT_REF: STAGING,
  PRODUCTION_PROJECT_REF: PRODUCTION,
  DATABASE_URL: pooler('ops_astro_api', STAGING),
  DATABASE_LOOKUP_URL: pooler('ops_astro_lookup_login', STAGING),
  GOTRUE_URL: `https://${STAGING}.supabase.co/auth/v1`,
  SUPABASE_SERVICE_KEY: 'service-key-value',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-value',
  ...overrides,
});

const local = (overrides: Record<string, string | undefined> = {}) => ({
  SCAN_LOGIN_PLACE: 'local',
  SCAN_LOGIN_FILE: '/tmp/scan-login.json',
  SCAN_TOKEN_FILE: '/tmp/scan-token',
  DATABASE_URL: 'postgres://app:pw@127.0.0.1:54570/ops_astro_local',
  DATABASE_LOOKUP_URL: 'postgres://postgres:pw@127.0.0.1:54570/ops_astro_local',
  GOTRUE_URL: 'http://127.0.0.1:54571',
  SUPABASE_SERVICE_KEY: 'local-service-token',
  ...overrides,
});

it("staging's settings, each in staging's project, pass for make and for remove", () => {
  expect(scanLoginRefusal(staging(), ['make'])).toBeUndefined();
  expect(scanLoginRefusal(staging(), ['remove'])).toBeUndefined();
  expect(scanLoginRefusal(local(), ['make'])).toBeUndefined();
});

it.each([
  ['no step', [], 'make or remove'],
  ['two steps', ['make', 'remove'], 'make or remove'],
  ['another step', ['reset'], 'make or remove'],
])('%s is refused', (_label, args, words) => {
  expect(scanLoginRefusal(staging(), args)).toContain(words);
});

it.each([
  ['an unknown place', { SCAN_LOGIN_PLACE: 'production' }, 'SCAN_LOGIN_PLACE'],
  ['no login file', { SCAN_LOGIN_FILE: undefined }, 'SCAN_LOGIN_FILE'],
  ['a relative login file', { SCAN_LOGIN_FILE: 'scan.json' }, 'SCAN_LOGIN_FILE'],
  ['no token file', { SCAN_TOKEN_FILE: undefined }, 'SCAN_TOKEN_FILE'],
  ['a relative token file', { SCAN_TOKEN_FILE: 'token' }, 'SCAN_TOKEN_FILE'],
  [
    "the runtime login in production's project",
    { DATABASE_URL: pooler('ops_astro_api', PRODUCTION) },
    "DATABASE_URL reaches production's project",
  ],
  [
    'the lookup login in another project',
    { DATABASE_LOOKUP_URL: pooler('ops_astro_lookup_login', 'qqqqqqqqqqqqqqqqqqqq') },
    "DATABASE_LOOKUP_URL is not staging's project",
  ],
  [
    "the sign-in address in production's project",
    { GOTRUE_URL: `https://${PRODUCTION}.supabase.co/auth/v1` },
    "GOTRUE_URL reaches production's project",
  ],
  ['a sign-in address on this machine', { GOTRUE_URL: 'http://127.0.0.1:54571' }, 'GOTRUE_URL'],
  [
    'staging named as production',
    { PRODUCTION_PROJECT_REF: STAGING },
    "STAGING_PROJECT_REF is production's",
  ],
  ['no service key', { SUPABASE_SERVICE_KEY: '' }, 'SUPABASE_SERVICE_KEY is not set'],
  [
    'no publishable key',
    { SUPABASE_PUBLISHABLE_KEY: undefined },
    'SUPABASE_PUBLISHABLE_KEY is not set',
  ],
  [
    'a database host that is not Supabase',
    { DATABASE_URL: 'postgres://a.b:pw@db.example.com/x' },
    'DATABASE_URL',
  ],
])('staging with %s is refused, named by setting', (_label, overrides, words) => {
  const refusal = scanLoginRefusal(staging(overrides), ['make']);
  expect(refusal).toContain(words);
  expect(refusal).not.toContain('pw@');
  expect(refusal).not.toContain('service-key-value');
});

it.each([
  ['a database off this machine', { DATABASE_URL: pooler('ops_astro_api', STAGING) }],
  [
    'a lookup login off this machine',
    { DATABASE_LOOKUP_URL: pooler('ops_astro_lookup_login', STAGING) },
  ],
  ['a sign-in address off this machine', { GOTRUE_URL: `https://${STAGING}.supabase.co/auth/v1` }],
  ['a sign-in address over https here', { GOTRUE_URL: 'https://127.0.0.1:54571' }],
])('the local place with %s is refused', (_label, overrides) => {
  expect(scanLoginRefusal(local(overrides), ['make'])).toMatch(/this machine/u);
});

it("the scan login is a made-up member of the made-up business, with a member's grants and no more", () => {
  expect(SCAN_BUSINESS).toBe('alpha');
  expect(SCAN_PERSON).toBe('Scan Alpha');
  expect(scanEmail('0123456789ab')).toBe('scan-0123456789ab@alpha.local');
  expect(() => scanEmail('ADA')).toThrow();
  expect(SCAN_GRANTS).toStrictEqual([
    ['task', 'read'],
    ['task', 'write'],
    ['task', 'assign'],
    ['person', 'read'],
    ['settings', 'read'],
  ]);
});

it('the login file is read back only in its own shape: the address and the sign-in', () => {
  const made = {
    email: 'scan-0123456789ab@alpha.local',
    userId: '11111111-1111-4111-8111-111111111111',
  };
  expect(loginRecord(JSON.stringify(made))).toStrictEqual(made);
  // The person is never taken from the file: removal finds it from the sign-in's own mapping.
  expect(loginRecord(JSON.stringify({ ...made, personId: 'x' }))).toStrictEqual(made);
  expect(() => loginRecord('{')).toThrow();
  expect(() => loginRecord(JSON.stringify({ ...made, userId: 'x' }))).toThrow();
  expect(() => loginRecord(JSON.stringify({ ...made, email: 'ada@alpha.local' }))).toThrow();
});

it('removal checks first: it refuses any sign-in or person that is not the scan login', () => {
  const email = 'scan-0123456789ab@alpha.local';
  expect(removalRefusal({ email, providerEmail: email, displayName: SCAN_PERSON })).toBeUndefined();
  expect(removalRefusal({ email, providerEmail: email, displayName: undefined })).toBeUndefined();
  // The sign-in already gone (an earlier remove, or a make that stopped): the rows still end.
  expect(
    removalRefusal({ email, providerEmail: undefined, displayName: SCAN_PERSON }),
  ).toBeUndefined();
  expect(
    removalRefusal({
      email: 'ada@alpha.local',
      providerEmail: undefined,
      displayName: SCAN_PERSON,
    }),
  ).toContain('sign-in');
  expect(
    removalRefusal({ email, providerEmail: 'ada@alpha.local', displayName: SCAN_PERSON }),
  ).toContain('sign-in');
  expect(removalRefusal({ email, providerEmail: email, displayName: 'Ada Alpha' })).toContain(
    'person',
  );
  // A sign-in the provider answers for with no address is not known to be the scan login's.
  expect(removalRefusal({ email, providerEmail: '', displayName: SCAN_PERSON })).toContain(
    'sign-in',
  );
});
