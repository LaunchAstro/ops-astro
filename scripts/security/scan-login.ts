// SPDX-License-Identifier: AGPL-3.0-only
//
// The security pass's scan login (S0-5 item 7), a made-up member the job makes
// and removes. Every refusal comes before anything connects, named by setting:
// on staging each address is staging's project and not production's; the local
// place takes this machine only.
// Removal checks first that the sign-in and the person are the scan login's,
// and that no other business maps the sign-in to a person of its own.

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
}

/** The login file `make` wrote: the address and the sign-in, nothing else read from it. */
export function loginRecord(text: string): LoginRecord {
  const parsed: unknown = JSON.parse(text);
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Readonly<
    Record<string, unknown>
  >;
  const { email, userId } = record;
  if (typeof email !== 'string' || !SCAN_EMAIL.test(email))
    throw new Refusal('the login file names no scan login');
  if (typeof userId !== 'string' || !UUID.test(userId))
    throw new Refusal('the login file names no sign-in');
  return { email, userId };
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
