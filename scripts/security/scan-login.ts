// SPDX-License-Identifier: AGPL-3.0-only
//
// The security pass's scan login (ticket S0-5 item 7): the authenticated API
// scan signs in as a made-up member the job makes before the scan and removes
// after it, so no seeded person's password is ever handed to a scanner. It is
// a member of staging's made-up business with a member's grants (the local
// seed's `member` row) and no more, at a made-up `.local` address the
// made-up-data guard admits (`scripts/ops/made-up-only.ts`).
//
// Every refusal here is made before anything connects, named by setting and
// never by value. On staging each address must be in staging's project and not
// production's (`databaseProject`, as the staging reset judges); the local
// place, for the dry run, takes only addresses on this machine. Removal checks
// first: it ends nothing unless the provider's sign-in and the person are the
// scan login's own. The decisions are here; `scan-login.mjs` runs them.

import { databaseProject, Refusal } from '../ops/staging-reset.ts';

export const SCAN_BUSINESS = 'alpha';
export const SCAN_PERSON = 'Scan Alpha';
/** The local seed's `member` grants (`scripts/local-seed.mjs`, GRANTS_BY_ROLE). */
export const SCAN_GRANTS: readonly (readonly [string, string])[] = [
  ['task', 'read'],
  ['task', 'write'],
  ['task', 'assign'],
  ['person', 'read'],
  ['settings', 'read'],
];

const NONCE = /^[0-9a-f]{12}$/u;
const SCAN_EMAIL = /^scan-[0-9a-f]{12}@alpha\.local$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REF = /^[a-z]{20}$/u;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);

type Environment = Readonly<Record<string, string | undefined>>;

function setting(environment: Environment, name: string): string {
  const value = environment[name] ?? '';
  if (value === '') throw new Refusal(`${name} is not set`);
  return value;
}

/** The address of one made-up scan login. */
export function scanEmail(nonce: string): string {
  if (!NONCE.test(nonce)) throw new Refusal('a scan login nonce is twelve hex characters');
  return `scan-${nonce}@alpha.local`;
}

function onThisMachine(environment: Environment): void {
  for (const name of ['DATABASE_URL', 'DATABASE_LOOKUP_URL']) {
    const url = URL.parse(setting(environment, name));
    if (
      url === null ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !LOCAL_HOSTS.has(url.hostname)
    )
      throw new Refusal(`${name} is not a database on this machine`);
  }
  const auth = URL.parse(setting(environment, 'GOTRUE_URL'));
  if (auth?.protocol !== 'http:' || !LOCAL_HOSTS.has(auth.hostname))
    throw new Refusal('GOTRUE_URL is not a sign-in address on this machine');
}

function inStaging(environment: Environment): void {
  const staging = setting(environment, 'STAGING_PROJECT_REF');
  if (!REF.test(staging)) throw new Refusal('STAGING_PROJECT_REF is not a project reference');
  const production = environment['PRODUCTION_PROJECT_REF'] ?? '';
  if (production !== '' && !REF.test(production))
    throw new Refusal('PRODUCTION_PROJECT_REF is not a project reference');
  if (production === staging) throw new Refusal("STAGING_PROJECT_REF is production's");
  const auth = URL.parse(setting(environment, 'GOTRUE_URL'));
  const authProject = /^([a-z]{20})\.supabase\.co$/u.exec(auth?.hostname ?? '')?.[1];
  if (auth?.protocol !== 'https:' || authProject === undefined || auth.pathname !== '/auth/v1')
    throw new Refusal("GOTRUE_URL is not a project's sign-in address");
  const reached: readonly (readonly [string, string])[] = [
    ['DATABASE_URL', databaseProject('DATABASE_URL', setting(environment, 'DATABASE_URL'))],
    [
      'DATABASE_LOOKUP_URL',
      databaseProject('DATABASE_LOOKUP_URL', setting(environment, 'DATABASE_LOOKUP_URL')),
    ],
    ['GOTRUE_URL', authProject],
  ];
  for (const [name, project] of reached) {
    if (project === production) throw new Refusal(`${name} reaches production's project`);
    if (project !== staging) throw new Refusal(`${name} is not staging's project`);
  }
  setting(environment, 'SUPABASE_PUBLISHABLE_KEY');
}

/** Every refusal before connecting, for `make` or `remove`, named by setting. */
export function scanLoginRefusal(
  environment: Environment,
  args: readonly string[],
): string | undefined {
  try {
    if (args.length !== 1 || !['make', 'remove'].includes(args[0] ?? ''))
      throw new Refusal('name one step: make or remove');
    const place = environment['SCAN_LOGIN_PLACE'];
    if (place !== 'staging' && place !== 'local')
      throw new Refusal('SCAN_LOGIN_PLACE is staging or local');
    for (const name of ['SCAN_LOGIN_FILE', 'SCAN_TOKEN_FILE'])
      if (!setting(environment, name).startsWith('/'))
        throw new Refusal(`${name} is not an absolute path`);
    if (place === 'local') onThisMachine(environment);
    else inStaging(environment);
    setting(environment, 'SUPABASE_SERVICE_KEY');
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}

export interface LoginRecord {
  readonly email: string;
  readonly userId: string;
  readonly businessId?: string;
  readonly personId?: string;
}

/** The login file `make` wrote, read back only in its own shape. */
export function loginRecord(text: string): LoginRecord {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null)
    throw new Refusal('the login file is not a record');
  const record = parsed as Readonly<Record<string, unknown>>;
  const email = record['email'];
  const userId = record['userId'];
  if (typeof email !== 'string' || !SCAN_EMAIL.test(email))
    throw new Refusal('the login file names no scan login');
  if (typeof userId !== 'string' || !UUID.test(userId))
    throw new Refusal('the login file names no sign-in');
  const out: { email: string; userId: string; businessId?: string; personId?: string } = {
    email,
    userId,
  };
  for (const name of ['businessId', 'personId'] as const) {
    const value = record[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !UUID.test(value))
      throw new Refusal(`the login file's ${name} is not an id`);
    out[name] = value;
  }
  return out;
}

/** Check first: the provider's sign-in and the person must be the scan login's own. */
export function removalRefusal(found: {
  readonly email: string;
  readonly providerEmail: string | undefined;
  readonly displayName: string | undefined;
}): string | undefined {
  // An absent provider sign-in is one already removed: the person's rows still end.
  const provider = found.providerEmail ?? found.email;
  if (provider !== found.email || !SCAN_EMAIL.test(found.email))
    return "the sign-in is not the scan login's; nothing was removed";
  if (found.displayName !== undefined && found.displayName !== SCAN_PERSON)
    return "the person is not the scan login's; nothing was removed";
  return undefined;
}
