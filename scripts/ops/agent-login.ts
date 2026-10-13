// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's sign-in, made by a person under operations:manage. `make` binds
// a new provider user to one agent actor of the operator's business
// (OPS_ASTRO_BUSINESS) and proves it. Before anything connects, every address
// must be on the one project the run is for, each database address asking for
// TLS, and production only with `--production`, both ways; then the operator
// gate; then each act's admission, under the lock order agent-login-acting.ts
// keeps. Nothing printed carries a password, a key, a bearer or an address.

import { parseArgs } from 'node:util';
import type { Context } from 'hono';
import { createSupabaseVerifier, keySetUrlFor } from '../../apps/api/auth/supabase.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { acting, admission, type Make, type Run } from './agent-login-acting.ts';
import { requireOperator } from './operator.ts';
import { databaseProject, projectRefs, Refusal } from './staging-reset.ts';

type Environment = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TLS_MODES: ReadonlySet<string> = new Set(['require', 'verify-ca', 'verify-full']);
const OPTIONS = {
  agent: { type: 'string' },
  email: { type: 'string' },
  production: { type: 'boolean' },
} as const;

const setting = (environment: Environment, name: string): string => {
  const value = environment[name] ?? '';
  if (value === '') throw new Refusal(`${name} is not set`);
  return value;
};

/** The sign-in address's project; a loopback stand-in belongs to none. */
function signInProject(value: string): string | undefined {
  const url = URL.parse(value);
  if (url?.protocol === 'http:' && url.hostname === '127.0.0.1') return undefined;
  const project = /^([a-z]{20})\.supabase\.co$/u.exec(url?.hostname ?? '')?.[1];
  if (url?.protocol !== 'https:' || project === undefined || url.pathname !== '/auth/v1')
    throw new Refusal("GOTRUE_URL is not a project's sign-in address");
  return project;
}

/** Every address on the run's one project, by setting and never by value. */
function oneProject(environment: Environment, production: boolean): void {
  const { own, other, ref, otherRef } = projectRefs(environment, production);
  for (const name of ['DATABASE_ADMIN_URL', 'DATABASE_URL']) {
    const value = setting(environment, name);
    const project = databaseProject(name, value);
    if (project === otherRef) throw new Refusal(`${name} reaches ${other}'s project`);
    if (project !== ref) throw new Refusal(`${name} is not ${own}'s project`);
    const query = new URL(value).searchParams;
    const modes = query.getAll('sslmode');
    if (modes.length !== 1 || !TLS_MODES.has(modes[0] ?? '') || query.has('ssl'))
      throw new Refusal(`${name} does not require TLS (add ?sslmode=require or stricter)`);
  }
  const signIn = signInProject(setting(environment, 'GOTRUE_URL'));
  // A loopback stand-in serves a staging run alone.
  if ((signIn ?? (production ? '' : ref)) !== ref)
    throw new Refusal(`GOTRUE_URL is not ${own}'s project`);
  setting(environment, 'SUPABASE_SERVICE_KEY');
}

/** The make, or the refusal made before connecting. */
export function makeInput(environment: Environment, args: readonly string[]): Make {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, options: OPTIONS });
  } catch {
    throw new Refusal('name the act: make --agent <actor id> --email <address>');
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1 || positionals[0] !== 'make')
    throw new Refusal('name one act: make');
  const agentId = values.agent ?? '';
  if (!UUID.test(agentId)) throw new Refusal('--agent is not an actor id');
  const address = /^([^@+\s]+)@([^@\s]+\.[^@\s]+)$/u.exec(values.email ?? '');
  if (address === null) throw new Refusal('--email is not an address without a +');
  const production = values.production === true;
  oneProject(environment, production);
  return { agentId, local: address[1] ?? '', domain: address[2] ?? '', production };
}

/** The addresses as connected: a test's throwaway server serves no TLS (plaintext-at-loopback.mjs). */
function reached(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (Reflect.get(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback')) !== true)
    return environment;
  const plain = { ...environment };
  for (const name of ['DATABASE_ADMIN_URL', 'DATABASE_URL']) {
    const url = new URL(plain[name] ?? '');
    url.searchParams.set('sslmode', 'disable');
    plain[name] = url.toString();
  }
  return plain;
}

/** A bearer verified as the API verifies it, against the run's sign-in service. */
function verifierFor(env: Readonly<Record<string, string>>): Run['verify'] {
  const issuer = env['GOTRUE_URL'] ?? '';
  const keySetUrl = keySetUrlFor(env['SUPABASE_KEY_SET_URL'] ?? '', issuer) ?? '';
  const verify = createSupabaseVerifier({ issuer, keySetUrl });
  return async (token) => {
    const bearer = `Bearer ${token}`;
    const header = (name: string): string | undefined =>
      name.toLowerCase() === 'authorization' ? bearer : undefined;
    const presented = await verify({ header } as unknown as Context['req']);
    return typeof presented === 'object' ? presented : undefined;
  };
}

/** Why a run stopped, naming a database error by its code alone, never its words. */
function stopped(error: unknown): string {
  if (error instanceof Refusal) return error.message;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)
    ? `the act stopped (${code})`
    : 'the act stopped';
}

/** The act, on the gate's connections; a cross-business read needs an owner login reading every row. */
async function act(run: Run): Promise<never> {
  const [owner] = await run.admin.execute<{ reads: boolean }>(
    'select rolsuper or rolbypassrls as reads from pg_roles where rolname = current_user',
  );
  if (owner?.reads !== true)
    throw new Refusal("DATABASE_ADMIN_URL's login cannot read every business's logins");
  await acting(run, null, async (execute) => await admission(execute, run));
  throw new Refusal('make is not built yet past its admission: nothing was written');
}

/** The whole run: its exit status and what it prints. */
export async function runAgentLogin(
  environment: Environment,
  args: readonly string[],
): Promise<{ status: 0 | 1; lines: string[] }> {
  let make: Make;
  try {
    make = makeInput(environment, args);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { status: 1, lines: [`agent-login: refused: ${error.message}. Nothing was done.`] };
  }
  const env = reached(environment as Readonly<Record<string, string>>);
  const gate = await requireOperator(env);
  if (!gate.ok) return { status: 1, lines: [`agent-login: refused: ${gate.reason}`] };
  const admin = connectAsAdmin(env['DATABASE_ADMIN_URL'] ?? '', { source: 'admin' });
  const runtime = connect(env['DATABASE_URL'] ?? '', { source: 'runtime' });
  const { businessId } = gate.operator;
  const run: Run = { env, make, gate, businessId, admin, runtime, verify: verifierFor(env) };
  try {
    return await act(run);
  } catch (error) {
    return {
      status: 1,
      lines: [`agent-login: stopped: ${stopped(error)}. A rerun resumes the act.`],
    };
  } finally {
    await Promise.all([admin.close(), runtime.close()]);
  }
}
