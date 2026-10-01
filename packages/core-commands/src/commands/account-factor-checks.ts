// SPDX-License-Identifier: AGPL-3.0-only
//
// C59's checks before a second-factor call (`account-factor.ts`): the wrong-code
// lockout, a fresh sign-in for a first enrolment, and the code's own shape.
// Split from `account-factor.ts` to keep that file under the line limit.

import { STEP_UP_WINDOW_SECONDS } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';

/**
 * Wrong codes a person may send before their factor routes stop asking the
 * provider: five in fifteen minutes, counted from their own refused attempts
 * in the audit chain, so a six-digit code cannot be walked by a caller who
 * holds only the password.
 */
const FAILED_CODE_LIMIT = 5;
const FAILED_CODE_WINDOW_MINUTES = 15;

/** Whether this person has sent too many wrong codes lately (see `FAILED_CODE_LIMIT`). */
export async function tooManyWrongCodes(tx: TenantQuery, session: Session): Promise<boolean> {
  const rows = await tx.query<{ readonly failures: number }>(
    `select count(*)::int as failures
       from public.audit_events
      where business_id = $1
        and actor_id = $2
        and command in ('account.factor_verify', 'account.factor_remove')
        and refusal_code = 'SECOND_FACTOR_INVALID'
        and occurred_at > now() - make_interval(mins => $3)`,
    [tx.businessId, session.actorId, FAILED_CODE_WINDOW_MINUTES],
  );
  return (rows[0]?.failures ?? 0) >= FAILED_CODE_LIMIT;
}

/** A first enrolment's precondition: a password sign-in inside the window. */
export async function freshSignIn(tx: TenantQuery, session: Session): Promise<boolean> {
  const signedInAt = session.assurance.signedInAt;
  if (signedInAt === null) return false;
  const rows = await tx.query<{ readonly now: number }>(
    'select floor(extract(epoch from now()))::float8 as now',
  );
  const age = (rows[0]?.now ?? Number.POSITIVE_INFINITY) - signedInAt;
  return age <= STEP_UP_WINDOW_SECONDS && age >= -60;
}

/** `{ "code": "123456" }` and nothing else: six digits, as authenticator apps show. */
export function codeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  const code = (body as Readonly<Record<string, unknown>>)['code'];
  if (keys.length !== 1 || typeof code !== 'string' || !/^[0-9]{6}$/u.test(code)) return undefined;
  return code;
}
