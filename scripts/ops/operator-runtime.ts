// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's own reads and acts on the installation's database
// (operator.ts): the business key, read as the lookup identity before anyone
// is admitted; then, as the runtime identity once a person is, the sign-in
// record after the act (I13), and the short hold a store part read and a
// deployment record start under (`holdingGrant`). Each act opens a connection
// of its own and closes it.

import { createBusinessResolver, LOOKUP_ROLE } from '../../apps/api/server.ts';
import {
  connect,
  OPERATIONS_MANAGE,
  SESSION_ABSOLUTE_SECONDS,
  standingOf,
  subjectsOf,
  withSession,
  type AdminConnection,
  type BusinessId,
  type TenantQuery,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { EFFECTIVE } from '../../packages/core-records/src/authority/grants.ts';
import { sessionEndedHeld } from '../../packages/core-records/src/identity/sessions.ts';
import {
  COVERED,
  coveringParameters,
  holdCoveringGrants,
} from '../../packages/core-records/src/site/covering.ts';

const CANNOT_TAKE_LOOKUP =
  `DATABASE_ADMIN_URL's login may not take the business lookup identity (${LOOKUP_ROLE}), ` +
  'so the sign-in cannot be checked: migration 20261005063514 grants it, with set true and inherit false';

/**
 * The business `key` names, read on `admin` as the server reads it, or
 * undefined. A database the lookup identity (0046) may not read holds no
 * business; an admin login that may not take the identity is no fault of the
 * operator's, so it is named (`why`) rather than answered as no business.
 */
export async function businessOf(
  admin: AdminConnection,
  key: string,
): Promise<string | undefined | { readonly why: string }> {
  try {
    return await createBusinessResolver(admin)(key);
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42501') throw error;
    const [may] = await admin.execute<{ set: boolean }>("select pg_has_role($1, 'SET') as set", [
      LOOKUP_ROLE,
    ]);
    return may?.set === true ? undefined : { why: CANNOT_TAKE_LOOKUP };
  }
}

/** How long a hold lasts at most, its lock waits included: a revocation waits no longer. */
export const HOLD_BUDGET_MS = 30_000;

/** The sign-in a gate admitted, as a hold asks after it again. */
export interface Admitted {
  readonly businessId: BusinessId;
  readonly personId: string;
  readonly presented: VerifiedSubject;
  /** The token's own `exp`, in seconds since the epoch. */
  readonly expiresAt: number;
}

/** The verified token's `exp`, or 0 (no time left) when it carries none. */
export function expiryOf(token: string): number {
  const payload = token.split('.')[1] ?? '';
  try {
    const exp: unknown = (
      JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: unknown }
    ).exp;
    return Number.isSafeInteger(exp) ? (exp as number) : 0;
  } catch {
    return 0;
  }
}

const ENDED = `the operator no longer holds ${OPERATIONS_MANAGE.collection}:${OPERATIONS_MANAGE.action} with this sign-in long enough to go on: stopped part way`;

/**
 * Record the admitted operator's sign-in attempt (I13), in a transaction of its
 * own, for the person the gate admitted: a sign-in that now resolves to anyone
 * else records nothing and is refused.
 */
export async function recordSignIn(
  url: string,
  businessId: BusinessId,
  presented: VerifiedSubject,
  personId: string,
): Promise<void> {
  const database = connect(url, { source: 'runtime' });
  try {
    await withSession(database, businessId, presented, (_tx, session) =>
      session.personId === personId ? Promise.resolve() : Promise.reject(new Error(ENDED)),
    );
  } finally {
    await database.close();
  }
}

// The login's own rows login resolution reads (login-resolution.ts), held so a
// remapping, a membership or an actor ended waits for the hold.
const LOGIN_ROWS = `
  select l.id from public.logins l
    join public.person_logins pl
      on pl.business_id = l.business_id and pl.login_id = l.id and pl.active
    join public.memberships m
      on m.business_id = pl.business_id and m.person_id = pl.person_id and m.active
    join public.actors a
      on a.business_id = pl.business_id and a.person_id = pl.person_id
     and a.kind = 'person' and a.active
   where l.provider = $1 and l.subject = $2 and pl.person_id = $3 and a.id = $4
     for share`;

// Covered over the whole business by a grant still live at the end of the
// budget, and the token and the session's absolute limit too, on the
// database's clock after every lock wait. A covering grant expires no later
// than any grant it descends from (`EFFECTIVE`).
const LIVE_THROUGH = `${EFFECTIVE}, instant as materialized (
    select clock_timestamp() + make_interval(secs => $6) as at)
  select (${COVERED})
     and to_timestamp(least($7::bigint, coalesce($8::bigint, 0) + $9::bigint))
         > (select i.at from instant i) as live
    from (select $1::uuid as business_id, null::uuid as party_id) c`;

/**
 * Lock first, judge second. Everything the gate's answer rests on is locked:
 * the grant chain covering the person and their actor, the login's rows, and
 * the session's ending keys (`sessionEndedHeld`). Then, inside this
 * transaction, the same person and actor must stand and be covered for the
 * whole budget. The operating business is written once, at installation.
 */
async function standsThrough(
  tx: TenantQuery,
  admitted: Admitted,
  seconds: number,
): Promise<boolean> {
  const first = await standingOf(tx, admitted.presented, 'required');
  if ('refused' in first || first.personId !== admitted.personId) return false;
  const covering = { subjects: subjectsOf(first), ...OPERATIONS_MANAGE };
  await holdCoveringGrants(tx, covering);
  const { provider, subject } = admitted.presented;
  const rows = await tx.query(LOGIN_ROWS, [provider, subject, first.personId, first.actorId]);
  if (rows.length === 0 || (await sessionEndedHeld(tx, admitted.presented))) return false;
  const now = await standingOf(tx, admitted.presented, 'required');
  if ('refused' in now || now.personId !== first.personId || now.actorId !== first.actorId) {
    return false;
  }
  const [live] = await tx.query<{ live: boolean }>(LIVE_THROUGH, [
    tx.businessId,
    ...coveringParameters(covering),
    seconds,
    admitted.expiresAt,
    admitted.presented.assurance?.signedInAt ?? null,
    SESSION_ABSOLUTE_SECONDS,
  ]);
  return live?.live === true;
}

/**
 * `during`, handed `release`, under a hold on everything the operator's
 * admission rests on (`standsThrough`), judged again once it is locked, in a
 * transaction of its own: a revocation, a sign-out or a remapping waits until
 * `during` calls `release` or ends, and never past `budgetMs`. A hold that
 * cannot be judged, or is not released within the budget, refuses: `release`
 * then throws, so whatever it guards is never started.
 */
export async function holdingGrant<T>(
  url: string,
  admitted: Admitted,
  during: (release: () => void) => Promise<T>,
  budgetMs: number = HOLD_BUDGET_MS,
): Promise<T> {
  const database = connect(url, { source: 'runtime' });
  let [end, held] = [(): void => {}, (): void => {}];
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const taken = new Promise<void>((resolve) => {
    held = resolve;
  });
  let state: 'holding' | 'released' | 'expired' = 'holding';
  const finish = (to: 'released' | 'expired'): void => {
    state = to;
    clearTimeout(deadline);
    end();
  };
  const deadline = setTimeout(() => finish('expired'), budgetMs);
  const expired = (): boolean => state === 'expired';
  const release = (): void => {
    if (expired()) throw new Error(ENDED);
    if (state === 'holding') finish('released');
  };
  const hold = database.withBusiness(admitted.businessId, async (tx) => {
    // The server's own bound, a second past the client's, should this process stall.
    await tx.query(
      `select set_config('statement_timeout', $1, true),
              set_config('idle_in_transaction_session_timeout', $1, true)`,
      [String(budgetMs + 1000)],
    );
    if (!(await standsThrough(tx, admitted, Math.ceil(budgetMs / 1000)))) throw new Error(ENDED);
    held();
    await ended;
  });
  try {
    await Promise.race([taken, hold]);
    if (expired()) throw new Error(ENDED);
    return await during(release);
  } finally {
    finish(expired() ? 'expired' : 'released');
    try {
      await hold;
    } finally {
      await database.close();
    }
  }
}
