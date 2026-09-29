// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate and the deployment record (ticket S0-1, line A4).
//
// Staging preparation, the staging deploy (S0-6), the promotion step and the
// restore drill (S0-3) are a
// person's acts under `operations:manage`, never an agent's and never under a
// delegation. Each command asks `requireOperator` before they read anything else, and write
// their record through `recordDeployment` only after they acted. A refusal,
// the gate's or the command's own (a running API), returns before the service
// manager, the artefact store, the production link, the record folder or the
// database is written, so a refused run writes nothing.
//
// The check is the product's own, run without the API: the promotion runs
// with the API stopped. The bearer is verified the way the API verifies it
// (`apps/api/auth/supabase.ts`), the business is resolved by key the way the
// server resolves it, and inside one transaction the login is resolved to a
// person (`resolveLogin`, which never resolves an agent's login) and the grant
// is checked over the whole business. Both connections are closed before it
// returns, because the migration runner refuses while any other session is
// connected. The check is read-only: its transaction always rolls back, the
// sign-in attempt login resolution records with it. The operator's sign-in
// (I13) is recorded by `recordDeployment`, once the act is done.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import {
  checkAuthority,
  connect,
  connectAsAdmin,
  OPERATIONS_MANAGE,
  resolveLogin,
  subjectsOf,
  withSession,
  type BusinessId,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { createSupabaseVerifier, keySetUrlFor } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';

/** The person an operator act runs as, and the business it was checked in. */
export interface Operator {
  readonly personId: string;
  readonly business: string;
}

export type Gate =
  | {
      readonly ok: true;
      readonly operator: Operator;
      readonly records: string;
      /** Commits the operator's sign-in attempt (I13); called only after the act. */
      readonly recordSignIn: () => Promise<void>;
    }
  | { readonly ok: false; readonly reason: string };

type Environment = Readonly<Record<string, string | undefined>>;

const KEY = `${OPERATIONS_MANAGE.collection}:${OPERATIONS_MANAGE.action}`;
/** What an agent or a delegation carries, as the command line names it. */
const NOT_A_PERSON = ['OPS_ASTRO_AGENT', 'OPS_ASTRO_DELEGATION', 'OPS_ASTRO_DELEGATION_FILE'];
const CHECKED_WITH = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'GOTRUE_URL'];
/** The file in the record folder, one JSON line per act. */
export const RECORD_FILE = 'deployments.jsonl';

function refused(why: string): Gate {
  return {
    ok: false,
    reason:
      `${why}. Staging preparation, the staging deploy, the promotion step and the restore drill are a person's acts under ${KEY}, ` +
      "never an agent's and never under a delegation: sign in as yourself (OPS_ASTRO_TOKEN) " +
      'in the business OPS_ASTRO_BUSINESS names. Nothing was done.',
  };
}

const set = (environment: Environment, name: string): boolean => (environment[name] ?? '') !== '';

/** Thrown inside the check's transaction, always, so nothing it read or wrote commits. */
class Answer extends Error {
  readonly personId: string | undefined;
  constructor(personId: string | undefined) {
    super('operator check answered');
    this.personId = personId;
  }
}

/**
 * The business and the person holding the key over all of it, or undefined.
 * Read-only: the transaction always ends in a rollback, so a refusal and an
 * admission alike commit nothing, the sign-in attempt login resolution writes
 * (I13) included. Both connections are closed.
 */
async function personHolding(
  env: Readonly<Record<string, string>>,
  business: string,
  presented: VerifiedSubject,
): Promise<{ readonly personId: string; readonly businessId: BusinessId } | undefined> {
  const admin = connectAsAdmin(env['DATABASE_ADMIN_URL']!, { source: 'admin' });
  const database = connect(env['DATABASE_URL']!, { source: 'runtime' });
  try {
    const businessId = await createBusinessResolver(admin)(business);
    if (businessId === undefined) return undefined;
    try {
      await database.withBusiness(businessId, async (tx) => {
        const session = await resolveLogin(tx, presented);
        if ('refused' in session) throw new Answer(undefined);
        const scope = { kind: 'business', id: null } as const;
        const decision = await checkAuthority(tx, subjectsOf(session), {
          ...OPERATIONS_MANAGE,
          scope,
        });
        throw new Answer(decision.ok ? session.personId : undefined);
      });
    } catch (error) {
      if (!(error instanceof Answer)) throw error;
      return error.personId === undefined
        ? undefined
        : { personId: error.personId, businessId: businessId as BusinessId };
    }
    throw new Error('operator: the check ended without an answer');
  } finally {
    await Promise.all([admin.close(), database.close()]);
  }
}

/** Record the admitted operator's sign-in attempt (I13), in a transaction of its own. */
async function recordSignIn(
  databaseUrl: string,
  businessId: BusinessId,
  presented: VerifiedSubject,
): Promise<void> {
  const database = connect(databaseUrl, { source: 'runtime' });
  try {
    await withSession(database, businessId, presented, async () => {});
  } finally {
    await database.close();
  }
}

/** The operator, or why not. Never throws on a caller's input; never prints a credential. */
export async function requireOperator(environment: Environment = process.env): Promise<Gate> {
  const agent = NOT_A_PERSON.find((name) => set(environment, name));
  if (agent !== undefined)
    return refused(`${agent} is set: an agent or a delegation never holds ${KEY}`);
  if (!set(environment, 'OPS_ASTRO_TOKEN') || !set(environment, 'OPS_ASTRO_BUSINESS')) {
    return refused("no person's sign-in: OPS_ASTRO_TOKEN and OPS_ASTRO_BUSINESS are both needed");
  }
  const unset = CHECKED_WITH.filter((name) => !set(environment, name));
  if (unset.length > 0)
    return refused(`${unset.join(', ')} not set, so the sign-in cannot be checked`);
  const env = environment as Readonly<Record<string, string>>;
  // Every refusal that needs no lookup comes first; the lookup commits nothing.
  const records = env['OPS_ASTRO_DEPLOYMENTS'] ?? '';
  if (records === '') {
    return {
      ok: false,
      reason:
        'OPS_ASTRO_DEPLOYMENTS is not set: name the folder the deployment record goes to. Nothing was done.',
    };
  }

  // The provider's published key set, as the API checks a sign-in (S0-6b).
  const keySetUrl = keySetUrlFor(env['SUPABASE_KEY_SET_URL'] ?? '', env['GOTRUE_URL']!);
  if (keySetUrl === undefined) {
    return refused('SUPABASE_KEY_SET_URL may name a loopback key set only, for a loopback issuer');
  }
  const verify = createSupabaseVerifier({ issuer: env['GOTRUE_URL']!, keySetUrl });
  const bearer = `Bearer ${env['OPS_ASTRO_TOKEN']!}`;
  const request = {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? bearer : undefined),
  };
  const presented = await verify(request as unknown as Context['req']);
  if (presented === undefined || presented === 'expired') {
    return refused('the sign-in did not verify: missing, forged or expired');
  }

  const business = env['OPS_ASTRO_BUSINESS']!;
  const held = await personHolding(env, business, presented);
  if (held === undefined) {
    return refused(
      `this sign-in is not a person of ${business} holding ${KEY} over the whole business`,
    );
  }
  return {
    ok: true,
    operator: { personId: held.personId, business },
    records,
    recordSignIn: async () => await recordSignIn(env['DATABASE_URL']!, held.businessId, presented),
  };
}

/**
 * Once the act is done: append its record (what was done, by which person, in
 * which business and when), then commit the operator's sign-in attempt (I13).
 * Never called on a refusal. The record carries no credential: the operator is
 * named by their person identifier.
 */
export async function recordDeployment(
  gate: Extract<Gate, { ok: true }>,
  act: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const record = {
    ...act,
    business: gate.operator.business,
    operator: gate.operator.personId,
    at: new Date().toISOString(),
  };
  mkdirSync(gate.records, { recursive: true, mode: 0o700 });
  appendFileSync(join(gate.records, RECORD_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await gate.recordSignIn();
  return record;
}
