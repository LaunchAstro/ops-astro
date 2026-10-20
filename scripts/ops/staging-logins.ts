// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging's database logins (ticket S0-1, STAGING-PREP B3), and production's
// with `--production`. A hosted project has no container that makes the
// product's logins (`scripts/local/db-up.sh` does it locally), so a person
// makes them with `staging-logins.mjs`, run twice:
//
// - `before-reset`: the group the migrations grant to (`ops_astro_app`) and the
//   runtime login in it, which the reset and the Vercel function use;
// - `after-reset`: one login for each group the migrations made, each only
//   able to set its role (noinherit), as the tests make them.
//
// Each address takes the Sydney pooler's `<login>.<reference>` form: the
// transaction port for what runs on Vercel, the session port for the M5's
// jobs. A password leaves this process only in the address written to the
// owner's folder; the database is sent its SCRAM verifier. The decisions are
// here; `staging-logins.mjs` runs them. Nothing it prints carries a value.
//
// Production's run makes the same logins in the same groups. Each run acts on
// its own project alone: staging's refuses production's project, and
// production's refuses staging's, so production's needs both references.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { databaseProject, POOLER, projectRefs, Refusal } from './staging-reset.ts';

export type Step = 'before-reset' | 'after-reset';

export interface Login {
  readonly step: Step;
  /** The setting its address goes into. */
  readonly setting: string;
  readonly role: string;
  readonly group: string;
  /** Inheriting, it holds its group's privileges; otherwise it must set the role. */
  readonly inherit: boolean;
  /** 6543 is the pooler's transaction mode (Vercel), 5432 its session mode (the M5). */
  readonly port: 5432 | 6543;
}

export const LOGINS: readonly Login[] = [
  {
    step: 'before-reset',
    setting: 'DATABASE_URL',
    role: 'ops_astro_api',
    group: 'ops_astro_app',
    inherit: true,
    port: 6543,
  },
  {
    step: 'after-reset',
    setting: 'DATABASE_LOOKUP_URL',
    role: 'ops_astro_lookup_login',
    group: 'ops_astro_lookup',
    inherit: false,
    port: 6543,
  },
  {
    step: 'after-reset',
    setting: 'BACKUP_SOURCE_URL',
    role: 'ops_astro_backup_login',
    group: 'ops_astro_backup',
    inherit: false,
    port: 5432,
  },
  {
    step: 'after-reset',
    setting: 'DATABASE_FORWARDER_URL',
    role: 'ops_astro_forwarder_login',
    group: 'ops_astro_forwarder',
    inherit: false,
    port: 5432,
  },
  {
    // 20261002105957: the daily upkeep job's second-factor purge (backup.mjs expire).
    step: 'after-reset',
    setting: 'DATABASE_UPKEEP_URL',
    role: 'ops_astro_upkeep_login',
    group: 'ops_astro_upkeep',
    inherit: false,
    port: 5432,
  },
  {
    // 20261018222300: the M5's trace export (#1708, apps/trace-export/main.ts).
    step: 'after-reset',
    setting: 'DATABASE_TRACE_URL',
    role: 'ops_astro_trace_login',
    group: 'ops_astro_trace',
    inherit: false,
    port: 5432,
  },
];

type Environment = Readonly<Record<string, string | undefined>>;
const STEPS: ReadonlySet<string> = new Set(['before-reset', 'after-reset']);
const PRODUCTION_FLAG = '--production';
const TLS_MODES: ReadonlySet<string> = new Set(['require', 'verify-ca', 'verify-full']);

function setting(environment: Environment, name: string): string {
  const value = environment[name] ?? '';
  if (value === '') throw new Refusal(`${name} is not set`);
  return value;
}

/** Production's run names `--production` after its step; staging's names the step alone. */
function isProduction(args: readonly string[]): boolean {
  return args.length === 2 && args[1] === PRODUCTION_FLAG;
}

/** The setting holding the project the run acts on. */
export function projectRefSetting(args: readonly string[]): string {
  return isProduction(args) ? 'PRODUCTION_PROJECT_REF' : 'STAGING_PROJECT_REF';
}

/** Every refusal made before connecting, named by setting and never by value. */
export function loginsRefusal(
  environment: Environment,
  args: readonly string[],
): string | undefined {
  try {
    const production = isProduction(args);
    if ((args.length !== 1 && !production) || !STEPS.has(args[0] ?? ''))
      throw new Refusal('name one step: before-reset or after-reset');
    const { own, other, ref, otherRef } = projectRefs(environment, production);
    const adminUrl = setting(environment, 'DATABASE_ADMIN_URL');
    const project = databaseProject('DATABASE_ADMIN_URL', adminUrl);
    if (project === otherRef) throw new Refusal(`DATABASE_ADMIN_URL reaches ${other}'s project`);
    if (project !== ref) throw new Refusal(`DATABASE_ADMIN_URL is not ${own}'s project`);
    // The addresses made here are the pooler's, so the admin address must name it.
    if (!POOLER.test(new URL(adminUrl).hostname.toLowerCase()))
      throw new Refusal("DATABASE_ADMIN_URL is not Supabase's pooler in Sydney");
    // The verifiers cross this connection: TLS, asked for in the address, is required.
    // Named once: postgres.js takes the last of a repeated parameter, this the first.
    const query = new URL(adminUrl).searchParams;
    const modes = query.getAll('sslmode');
    if (modes.length !== 1 || !TLS_MODES.has(modes[0] ?? '') || query.has('ssl'))
      throw new Refusal(
        'DATABASE_ADMIN_URL does not require TLS (add ?sslmode=require or stricter)',
      );
    setting(environment, 'OPS_LOGINS_DIR');
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}

export interface LoginAddress {
  readonly login: Login;
  readonly password: string;
  readonly address: string;
}

/** A fresh password for each of the step's logins, and its pooler address. */
export function loginAddresses(
  adminUrl: string,
  project: string,
  step: Step,
  password: () => string = () => randomBytes(24).toString('base64url'),
): LoginAddress[] {
  const admin = new URL(adminUrl);
  return LOGINS.filter((login) => login.step === step).map((login) => {
    const secret = password();
    const address = new URL(`postgresql://${admin.hostname}`);
    address.username = `${login.role}.${project}`;
    address.password = secret;
    address.port = String(login.port);
    address.pathname = admin.pathname;
    // postgres.js and libpq turn TLS on only when the address asks for it.
    address.search = '?sslmode=require';
    return { login, password: secret, address: address.toString() };
  });
}

/** The verifier Postgres stores for a SCRAM-SHA-256 password (RFC 5802, RFC 7677). */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = 4096,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(clientKey).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${stored}:${server}`;
}

/** How long a transaction on a Vercel login may sit idle before the server ends its session. */
export const IDLE_IN_TRANSACTION = '60s';

/**
 * The statements for one step, each login made if absent and its password set
 * every run. Role names are this file's constants; the only other text is a
 * verifier, whose alphabet (base64, `$`, `:`) cannot end a quoted literal.
 */
export function statementsFor(step: Step, addresses: readonly LoginAddress[]): string[] {
  const statements: string[] = [];
  if (step === 'before-reset') {
    statements.push(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = 'ops_astro_app') ` +
        `then create role ops_astro_app nologin; end if; end $$`,
    );
  }
  for (const { login, password } of addresses) {
    const inherit = login.inherit ? 'inherit' : 'noinherit';
    statements.push(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = '${login.role}') ` +
        `then create role ${login.role} login nosuperuser nocreatedb nocreaterole nobypassrls ` +
        `noreplication ${inherit}; end if; end $$`,
      // Hosted Supabase's admin is no superuser: an alter may not name SUPERUSER,
      // REPLICATION or BYPASSRLS at all, so a login already there is judged
      // before this runs (`loginsBeyondTheirGroup`) rather than stripped here.
      `alter role ${login.role} with login ${inherit} password '${scramVerifier(password)}'`,
      // Since Postgres 16 the membership's own option decides inheriting; set every run.
      `grant ${login.group} to ${login.role} with inherit ${String(login.inherit)}`,
    );
    if (login.port === 6543) {
      // A Vercel instance may be frozen mid-transaction once it answers, and its
      // session then holds its row locks until the server ends it (#2240).
      statements.push(
        `alter role ${login.role} set idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION}'`,
      );
    }
  }
  if (step === 'before-reset') {
    // As db-up.sh: a temporary table outlives the transaction on a pooled backend.
    statements.push(
      `do $$ begin execute format('revoke temporary on database %I from public', ` +
        `current_database()); end $$`,
    );
  }
  return statements;
}

export interface ExistingLogin {
  readonly rolname: string;
  readonly powers: boolean;
  readonly admin: boolean;
  readonly groups: readonly string[];
  /** It owns, or is granted directly, something in this database or the cluster's. */
  readonly direct?: boolean;
}

/**
 * What the step's logins already hold. A direct grant or an owned object is
 * read from pg_shdepend, which records each for this database (and for shared
 * objects, database 0); its role memberships are the groups.
 */
export const EXISTING_LOGINS = `
  select r.rolname,
         (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication)
           as powers,
         coalesce((select bool_or(m.admin_option) from pg_auth_members m
                    where m.member = r.oid), false) as admin,
         coalesce((select array_agg(g.rolname order by g.rolname) from pg_auth_members m
                    join pg_roles g on g.oid = m.roleid where m.member = r.oid), '{}') as groups,
         exists (select from pg_shdepend d
                  where d.refclassid = 'pg_authid'::regclass and d.refobjid = r.oid
                    and d.classid <> 'pg_auth_members'::regclass
                    and d.dbid in (0, (select oid from pg_database
                                        where datname = current_database()))) as direct
    from pg_roles r where r.rolname = any($1)`;

/**
 * A login already there must hold exactly its one group, no admin option, no
 * power and nothing granted to it directly, or the run is refused before
 * anything changes: the admin cannot take a power away on hosted Supabase, so
 * it never hands such a login on.
 */
export function loginsBeyondTheirGroup(existing: readonly ExistingLogin[]): string | undefined {
  for (const row of existing) {
    const own = LOGINS.find((login) => login.role === row.rolname)?.group;
    if (row.powers || row.admin || row.direct || row.groups.length !== 1 || row.groups[0] !== own) {
      return `${row.rolname} already holds more than its one group: drop it by hand, then run this again`;
    }
  }
  return undefined;
}
