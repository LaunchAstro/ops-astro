// SPDX-License-Identifier: AGPL-3.0-only
//
// C59's checks before a second-factor call (`account-factor.ts`): the wrong-code
// lockout, a fresh sign-in for a first enrolment, and the code's own shape.
// Split from `account-factor.ts` to keep that file under the line limit.

import { liveFactor, STEP_UP_WINDOW_SECONDS } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/**
 * Wrong codes a person may send before their factor routes stop asking the
 * provider: five in fifteen minutes, so a six-digit code cannot be walked by a
 * caller who holds only the password.
 */
const FAILED_CODE_LIMIT = 5;
const FAILED_CODE_WINDOW_MINUTES = 15;
const LOCKED_FIXES: readonly string[] = [
  'Too many wrong codes. Wait 15 minutes, then try again with the code your app shows.',
];

/** The event that a code is on its way to the provider; the act's own event names its answer. */
const CODE_SENT = 'account.factor_code_sent';

/**
 * `SECOND_FACTOR_LOCKED` when this person has sent too many wrong codes lately
 * (see `FAILED_CODE_LIMIT`): codes they sent (`codeSent`) that the provider
 * has not answered otherwise, so a wrong one and one still at the provider,
 * which may be wrong. A good code, once answered, does not count. It takes the
 * person's lock first, held to the end of the transaction that records the
 * code as sent, so requests at once are counted one after another, each
 * seeing the codes the others sent.
 */
export async function wrongCodeLock(
  tx: TenantQuery,
  session: Session,
): Promise<CommandRefusal | undefined> {
  await liveFactor(tx, session.personId, { lock: true });
  const rows = await tx.query<{ readonly failures: number }>(
    `select count(*)::int as failures
       from public.audit_events sent
      where sent.business_id = $1
        and sent.actor_id = $2
        and sent.command = $4
        and sent.occurred_at > now() - make_interval(mins => $3)
        and not exists (
          select 1 from public.audit_events answer
           where answer.business_id = $1
             and answer.operation_id = sent.operation_id
             and answer.command in ('account.factor_verify', 'account.factor_remove')
             and answer.refusal_code is distinct from 'SECOND_FACTOR_INVALID')`,
    [tx.businessId, session.actorId, FAILED_CODE_WINDOW_MINUTES, CODE_SENT],
  );
  return (rows[0]?.failures ?? 0) >= FAILED_CODE_LIMIT
    ? refuseCommand('SECOND_FACTOR_LOCKED', [], LOCKED_FIXES)
    : undefined;
}

/**
 * Record that a code is about to go to the provider, under the lock the count
 * took. The act's own event, written once the provider has answered, carries
 * the same `attempt` id as its operation.
 */
export async function codeSent(
  tx: TenantQuery,
  session: Session,
  attempt: string | undefined,
): Promise<void> {
  if (attempt === undefined) return;
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: CODE_SENT,
    operationId: attempt,
    outcome: 'applied',
    payloadDigest: payloadDigest({ command: CODE_SENT, person: session.personId }),
  });
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
