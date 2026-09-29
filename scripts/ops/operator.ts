// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate and the deployment record (ticket S0-1, line A4).
//
// Staging preparation and the promotion step are a person's acts under
// `operations:manage`, never an agent's and never under a delegation. Both
// commands ask `requireOperator` before they read anything else, and write
// their record through `recordDeployment` only after they acted. A refusal
// returns before the service manager, the artefact store, the production link
// or the record folder is touched, so a refused run writes nothing of its own.
//
// The check is the product's own, run without the API: the promotion runs
// with the API stopped. The bearer is verified the way the API verifies it
// (`apps/api/auth/supabase.ts`), the business is resolved by key the way the
// server resolves it, and inside one transaction the login is resolved to a
// person (`withSession`, which never resolves an agent's login) and the grant
// is checked over the whole business. Both connections are closed before it
// returns, because the migration runner refuses while any other session is
// connected. Login resolution records the sign-in attempt in that business's
// own trail (I13); that is the one row the check writes.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import {
  checkAuthority,
  connect,
  connectAsAdmin,
  OPERATIONS_MANAGE,
  subjectsOf,
  withSession,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';

/** The person an operator act runs as, and the business it was checked in. */
export interface Operator {
  readonly personId: string;
  readonly business: string;
}

export type Gate =
  | { readonly ok: true; readonly operator: Operator; readonly records: string }
  | { readonly ok: false; readonly reason: string };

type Environment = Readonly<Record<string, string | undefined>>;

const KEY = `${OPERATIONS_MANAGE.collection}:${OPERATIONS_MANAGE.action}`;
/** What an agent or a delegation carries, as the command line names it. */
const NOT_A_PERSON = ['OPS_ASTRO_AGENT', 'OPS_ASTRO_DELEGATION', 'OPS_ASTRO_DELEGATION_FILE'];
const CHECKED_WITH = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SUPABASE_JWT_SECRET', 'GOTRUE_URL'];
/** The file in the record folder, one JSON line per act. */
export const RECORD_FILE = 'deployments.jsonl';

function refused(why: string): Gate {
  return {
    ok: false,
    reason:
      `${why}. Staging preparation and the promotion step are a person's acts under ${KEY}, ` +
      "never an agent's and never under a delegation: sign in as yourself (OPS_ASTRO_TOKEN) " +
      'in the business OPS_ASTRO_BUSINESS names. Nothing was done.',
  };
}

const set = (environment: Environment, name: string): boolean => (environment[name] ?? '') !== '';

/** The person holding the key over the whole business, read in one transaction; both connections closed. */
async function personHolding(
  env: Readonly<Record<string, string>>,
  business: string,
  presented: VerifiedSubject,
): Promise<string | undefined> {
  const admin = connectAsAdmin(env['DATABASE_ADMIN_URL']!, { source: 'admin' });
  const database = connect(env['DATABASE_URL']!, { source: 'runtime' });
  try {
    const businessId = await createBusinessResolver(admin)(business);
    if (businessId === undefined) return undefined;
    const held = await withSession(database, businessId, presented, async (tx, session) => {
      const scope = { kind: 'business', id: null } as const;
      const decision = await checkAuthority(tx, subjectsOf(session), {
        ...OPERATIONS_MANAGE,
        scope,
      });
      return decision.ok ? session.personId : undefined;
    });
    return typeof held === 'string' ? held : undefined;
  } finally {
    await Promise.all([admin.close(), database.close()]);
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

  const verify = createSupabaseVerifier({
    secret: env['SUPABASE_JWT_SECRET']!,
    issuer: env['GOTRUE_URL']!,
  });
  const bearer = `Bearer ${env['OPS_ASTRO_TOKEN']!}`;
  const request = {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? bearer : undefined),
  };
  const presented = await verify(request as unknown as Context['req']);
  if (presented === undefined || presented === 'expired') {
    return refused('the sign-in did not verify: missing, forged or expired');
  }

  const business = env['OPS_ASTRO_BUSINESS']!;
  const personId = await personHolding(env, business, presented);
  if (personId === undefined) {
    return refused(
      `this sign-in is not a person of ${business} holding ${KEY} over the whole business`,
    );
  }
  const records = env['OPS_ASTRO_DEPLOYMENTS'] ?? '';
  if (records === '') {
    return {
      ok: false,
      reason:
        'OPS_ASTRO_DEPLOYMENTS is not set: name the folder the deployment record goes to. Nothing was done.',
    };
  }
  return { ok: true, operator: { personId, business }, records };
}

/**
 * Append one act's record: what was done, by which person, in which business
 * and when. Written after the act, never on a refusal. It carries no
 * credential: the operator is named by their person identifier.
 */
export function recordDeployment(
  records: string,
  operator: Operator,
  act: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const record = {
    ...act,
    business: operator.business,
    operator: operator.personId,
    at: new Date().toISOString(),
  };
  mkdirSync(records, { recursive: true, mode: 0o700 });
  appendFileSync(join(records, RECORD_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}
