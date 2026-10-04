// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging reset (ticket S0-1, re-plan section 11 step 3, STAGING-PREP B4):
// empty, migrate, seed. The decisions are here; `staging-reset.mjs` runs them.
//
// Staging holds made-up data only, so the reset loads no file (a backup is
// never its input) and makes everything it holds: the local seed's two made-up
// businesses and their people, with invented names, and the made-up staging
// operator holding `operations:manage` in the operating business, so staging's
// gate reads staging's own database (G1). Their sign-ins are made through the
// provider's admin API, confirmed as they are made, so no mail is sent.
//
// It refuses, by setting name and before it connects, any database or sign-in
// address whose Supabase project reference is not STAGING_PROJECT_REF, or is
// PRODUCTION_PROJECT_REF. A database host is only a project's own direct host,
// `db.<reference>.supabase.co`, or Supabase's pooler in staging's region, which
// picks the project by the login's `<login>.<reference>`; any other host is
// refused, whatever its login says. It never prints an address, a password, a
// key or a reference.

export interface CastMember {
  readonly email: string;
  readonly business: 'A' | 'B';
  readonly person: string;
  readonly role: string;
  readonly grants?: readonly (readonly [string, string])[];
}

/** The local seed's cast, as the click-through meets it, and staging's operator. */
export const STAGING_CAST: readonly CastMember[] = [
  { email: 'ada@alpha.local', business: 'A', person: 'Ada Alpha', role: 'admin' },
  { email: 'mia@alpha.local', business: 'A', person: 'Mia Alpha', role: 'member' },
  { email: 'noah@alpha.local', business: 'A', person: 'Noah Alpha', role: 'member', grants: [] },
  { email: 'orphan@alpha.local', business: 'A', person: 'Orphan Alpha', role: 'none' },
  { email: 'bea@bravo.local', business: 'B', person: 'Bea Bravo', role: 'member' },
  {
    email: 'olive@alpha.local',
    business: 'A',
    person: 'Olive Alpha',
    role: 'member',
    grants: [['operations', 'manage']],
  },
];

/** Staging's operating business, written once after the seed (migration 0045). */
export const OPERATING_BUSINESS = 'alpha';

const SURNAME = { A: 'Alpha', B: 'Bravo' } as const;
const ADDRESS = { A: '@alpha.local', B: '@bravo.local' } as const;

/**
 * The names that are not invented: an invented one is a first name and its
 * made-up business's name, at that business's made-up address.
 */
export function notInvented(cast: readonly CastMember[]): string[] {
  return cast
    .filter(
      (member) =>
        !/^[A-Z][a-z]+ [A-Z][a-z]+$/u.test(member.person) ||
        !member.person.endsWith(` ${SURNAME[member.business]}`) ||
        !member.email.endsWith(ADDRESS[member.business]),
    )
    .map((member) => member.person);
}

export class Refusal extends Error {}

const REF = /^[a-z]{20}$/u;
/** Supabase's shared pooler in Sydney, staging's region (NATHAN-SUPABASE-FREE). */
export const POOLER: RegExp = /^aws-[0-9]+-ap-southeast-2\.pooler\.supabase\.com$/u;
type Environment = Readonly<Record<string, string | undefined>>;

function setting(environment: Environment, name: string): string {
  const value = environment[name] ?? '';
  if (value === '') throw new Refusal(`${name} is not set`);
  return value;
}

/** The project a database address reaches, read from its login or its direct host. */
export function databaseProject(name: string, value: string): string {
  const url = URL.parse(value);
  if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Refusal(`${name} is not a database address`);
  // A host or login named in the query would override the one judged here. Read
  // decoded, as the driver reads it: `%75ser` is `user`.
  if ([...url.searchParams.keys()].some((key) => /^(?:host|hostaddr|port|user)$/iu.test(key)))
    throw new Refusal(`${name} names its host twice`);
  const host = url.hostname.toLowerCase();
  // One named host: the driver falls back to PGHOST for none and tries a list in turn.
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(host)) throw new Refusal(`${name} names no one host`);
  let user = '';
  try {
    user = decodeURIComponent(url.username);
  } catch {
    throw new Refusal(`${name} is not a database address`);
  }
  // One dot: the pooler must read the same reference from the login as this does.
  const login = /^[^.]+\.([a-z]{20})$/u.exec(user)?.[1];
  const direct = /^db\.([a-z]{20})\.supabase\.co$/u.exec(host)?.[1];
  if (direct !== undefined && (login === undefined || login === direct)) return direct;
  // Only the pooler routes by the login: anywhere else a login's reference proves nothing.
  if (direct === undefined && !POOLER.test(host))
    throw new Refusal(`${name} is not a staging database host`);
  if (login === undefined || direct !== undefined)
    throw new Refusal(`${name} names no one project (its login must be <login>.<reference>)`);
  return login;
}

/** The project a sign-in address belongs to; a loopback stand-in belongs to none. */
function authProject(value: string): string | undefined {
  const url = URL.parse(value);
  if (url?.protocol === 'http:' && url.hostname === '127.0.0.1') return undefined;
  const project = /^([a-z]{20})\.supabase\.co$/u.exec(url?.hostname ?? '')?.[1];
  if (url?.protocol !== 'https:' || project === undefined || url.pathname !== '/auth/v1')
    throw new Refusal("GOTRUE_URL is not a project's sign-in address");
  return project;
}

/**
 * Every refusal the reset makes before it connects: an argument (it loads no
 * file), a setting missing or malformed, or an address outside staging's
 * project or inside production's. Named by setting, never by value.
 */
export function refusalBeforeConnecting(
  environment: Environment,
  args: readonly string[],
): string | undefined {
  try {
    if (args.length > 0)
      throw new Refusal(
        "the reset loads no file: a backup is never its input, production's or any other",
      );
    const cast = notInvented(STAGING_CAST);
    if (cast.length > 0) throw new Refusal(`the cast holds names that are not invented`);
    const staging = setting(environment, 'STAGING_PROJECT_REF');
    if (!REF.test(staging)) throw new Refusal('STAGING_PROJECT_REF is not a project reference');
    const production = environment['PRODUCTION_PROJECT_REF'] ?? '';
    if (production !== '' && !REF.test(production))
      throw new Refusal('PRODUCTION_PROJECT_REF is not a project reference');
    if (production === staging) throw new Refusal("STAGING_PROJECT_REF is production's");
    const reached: [string, string | undefined][] = [
      [
        'DATABASE_ADMIN_URL',
        databaseProject('DATABASE_ADMIN_URL', setting(environment, 'DATABASE_ADMIN_URL')),
      ],
      ['DATABASE_URL', databaseProject('DATABASE_URL', setting(environment, 'DATABASE_URL'))],
      ['GOTRUE_URL', authProject(setting(environment, 'GOTRUE_URL'))],
    ];
    for (const [name, project] of reached) {
      if (project === undefined) continue;
      if (project === production) throw new Refusal(`${name} reaches production's project`);
      if (project !== staging) throw new Refusal(`${name} is not staging's project`);
    }
    setting(environment, 'SUPABASE_SERVICE_KEY');
    setting(environment, 'OPS_SEED_DIR');
    setting(environment, 'OPS_ASTRO_DEPLOYMENTS');
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}

/** The tenant tables, locked against writes while the reset judges and empties them. */
export const TENANT_TABLES: string = `select c.oid::regclass::text as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and exists (select from pg_attribute a
           where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped)`;

/**
 * The sessions ended installation-wide (0061, 0063) outlive the reset, as the
 * sign-ins they end do: carried into a schema the reset does not empty, merged
 * with any a stopped run left there, and put back once migrated. The last
 * statement runs the copy, in the emptying's transaction (staging-reset.mjs):
 * it locks each source against new endings until the emptying commits, so an
 * ending committed before it is carried, and one begun after waits and then
 * fails, never lost.
 */
export const CARRY_ENDED_SESSIONS: readonly string[] = [
  'create schema if not exists ops_astro_reset',
  'revoke all on schema ops_astro_reset from public',
  `create table if not exists ops_astro_reset.ended_provider_sessions
     (session_id uuid primary key, ended_at timestamptz not null)`,
  `create table if not exists ops_astro_reset.ended_subject_sessions
     (subject_digest text not null, kept_session uuid, ended_before timestamptz not null)`,
  `create or replace function ops_astro_reset.carry_ended_sessions() returns void
     language plpgsql as $$ begin
     if to_regclass('ops.ended_provider_sessions') is not null then
       lock table ops.ended_provider_sessions in share mode;
       insert into ops_astro_reset.ended_provider_sessions
         select session_id, ended_at from ops.ended_provider_sessions on conflict do nothing;
     end if;
     if to_regclass('ops.ended_subject_sessions') is not null then
       lock table ops.ended_subject_sessions in share mode;
       insert into ops_astro_reset.ended_subject_sessions
         select subject_digest, kept_session, ended_before from ops.ended_subject_sessions
         except select * from ops_astro_reset.ended_subject_sessions;
     end if;
   end $$`,
  'select ops_astro_reset.carry_ended_sessions()',
];
export const RESTORE_ENDED_SESSIONS: readonly string[] = [
  `insert into ops.ended_provider_sessions (session_id, ended_at)
     select session_id, ended_at from ops_astro_reset.ended_provider_sessions`,
  `insert into ops.ended_subject_sessions (subject_digest, kept_session, ended_before)
     select subject_digest, kept_session, ended_before from ops_astro_reset.ended_subject_sessions`,
  'drop schema ops_astro_reset cascade',
];
