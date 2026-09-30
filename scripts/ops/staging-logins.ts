// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging's database logins (ticket S0-1, STAGING-PREP B3). Hosted staging has
// no container that makes the product's logins (`scripts/local/db-up.sh` does
// it locally), so a person makes them with `staging-logins.mjs`, run twice:
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

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { databaseProject, POOLER, Refusal } from './staging-reset.ts';

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
];

type Environment = Readonly<Record<string, string | undefined>>;
const STEPS: ReadonlySet<string> = new Set(['before-reset', 'after-reset']);
const REF = /^[a-z]{20}$/u;

function setting(environment: Environment, name: string): string {
  const value = environment[name] ?? '';
  if (value === '') throw new Refusal(`${name} is not set`);
  return value;
}

/** Every refusal made before connecting, named by setting and never by value. */
export function loginsRefusal(
  environment: Environment,
  args: readonly string[],
): string | undefined {
  try {
    if (args.length !== 1 || !STEPS.has(args[0] ?? ''))
      throw new Refusal('name one step: before-reset or after-reset');
    const staging = setting(environment, 'STAGING_PROJECT_REF');
    if (!REF.test(staging)) throw new Refusal('STAGING_PROJECT_REF is not a project reference');
    const production = environment['PRODUCTION_PROJECT_REF'] ?? '';
    if (production !== '' && !REF.test(production))
      throw new Refusal('PRODUCTION_PROJECT_REF is not a project reference');
    if (production === staging) throw new Refusal("STAGING_PROJECT_REF is production's");
    const adminUrl = setting(environment, 'DATABASE_ADMIN_URL');
    const project = databaseProject('DATABASE_ADMIN_URL', adminUrl);
    if (project === production)
      throw new Refusal("DATABASE_ADMIN_URL reaches production's project");
    if (project !== staging) throw new Refusal("DATABASE_ADMIN_URL is not staging's project");
    // The addresses made here are the pooler's, so the admin address must name it.
    if (!POOLER.test(new URL(adminUrl).hostname.toLowerCase()))
      throw new Refusal("DATABASE_ADMIN_URL is not Supabase's pooler in Sydney");
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
  staging: string,
  step: Step,
  password: () => string = () => randomBytes(24).toString('base64url'),
): LoginAddress[] {
  const admin = new URL(adminUrl);
  return LOGINS.filter((login) => login.step === step).map((login) => {
    const secret = password();
    const address = new URL(`postgresql://${admin.hostname}`);
    address.username = `${login.role}.${staging}`;
    address.password = secret;
    address.port = String(login.port);
    address.pathname = admin.pathname;
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
      `alter role ${login.role} with login nosuperuser nocreatedb nocreaterole nobypassrls ` +
        `noreplication ${inherit} password '${scramVerifier(password)}'`,
      `grant ${login.group} to ${login.role}`,
    );
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
}

/** Not judged yet (review 56da29b, finding 2): the next commit decides it. */
export function loginsBeyondTheirGroup(_existing: readonly ExistingLogin[]): string | undefined {
  return undefined;
}
