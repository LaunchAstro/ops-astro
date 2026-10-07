// SPDX-License-Identifier: AGPL-3.0-only
//
// C59's checks before a second-factor call (`account-factor.ts`): the wrong-code
// lockout, a fresh sign-in for a first enrolment, the code's own shape, and
// which factor a code is checked against.
// Split from `account-factor.ts` to keep that file under the line limit.

import { createHash } from 'node:crypto';
import {
  advisoryLock,
  liveFactor,
  loginHasVerifiedFactor,
  loginVerifiedFactors,
  STEP_UP_WINDOW_SECONDS,
} from '../../../core-records/src/index.ts';
import type {
  SecondFactor,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/**
 * Wrong codes a login may send before its factor routes stop asking the
 * provider: five in fifteen minutes, through every business the login
 * reaches, so a six-digit code cannot be walked by a caller who holds only
 * the password.
 */
const FAILED_CODE_LIMIT = 5;
const FAILED_CODE_WINDOW_MINUTES = 15;
const LOCKED_FIXES: readonly string[] = [
  'Too many wrong codes. Wait 15 minutes, then try again with the code your app shows.',
];

export const ENROLLED_FIXES: readonly string[] = [
  'You already have an authenticator app. To replace it, remove it with a code from it first.',
];
export const NOT_ENROLLED_FIXES: readonly string[] = ['Set up an authenticator app first.'];
export const BODY_FIXES: readonly string[] = ['Send only { "code": "<the six digits>" }.'];

/** The event that a code is on its way to the provider; the act's own event names its answer. */
const CODE_SENT = 'account.factor_code_sent';

/** The login's subject as `ops.second_factor_codes` keys it (0072). */
const subjectDigest = (subject: string) => createHash('sha256').update(subject).digest('hex');

/**
 * `SECOND_FACTOR_LOCKED` when this login has sent too many wrong codes lately
 * (see `FAILED_CODE_LIMIT`), through any business: codes sent (`recordCode`)
 * that the provider has not proved good, so a wrong one, one still at the
 * provider and one it answered with a fault, any of which may be wrong. A good
 * code, once proved, does not count. The provider holds one factor per login,
 * so the count and its lock are the login's (0072): an advisory lock on the
 * subject's digest, one of the two keys named by login rather than business
 * (`advisoryLock`), taken first in the transaction and held to the end of the
 * one that records the code as sent, so requests at once, in any business,
 * are counted one after another.
 */
export async function wrongCodeLock(
  tx: TenantQuery,
  subject: string,
): Promise<CommandRefusal | undefined> {
  const digest = subjectDigest(subject);
  await advisoryLock(tx, `second-factor-codes:${digest}`);
  const rows = await tx.query<{ readonly failures: number }>(
    `select count(*)::int as failures
       from ops.second_factor_codes sent
      where sent.subject_digest = $1
        and sent.state = 'sent'
        and sent.recorded_at > now() - make_interval(mins => $2)
        and not exists (
          select 1 from ops.second_factor_codes answer
           where answer.subject_digest = $1
             and answer.attempt = sent.attempt
             and answer.state = 'answered')`,
    [digest, FAILED_CODE_WINDOW_MINUTES],
  );
  return (rows[0]?.failures ?? 0) >= FAILED_CODE_LIMIT
    ? refuseCommand('SECOND_FACTOR_LOCKED', [], LOCKED_FIXES)
    : undefined;
}

/**
 * A code's place in the count, for a call that sends one (`attempt`). Before
 * the provider call, a check that passed records the code as sent, under the
 * lock `wrongCodeLock` took, in the login's record and as an audit event in
 * this business. After it, a code the provider proved good (`proven`) is
 * recorded as answered, so it stops counting; a wrong one, and one the
 * provider answered slowly, not at all or in a shape it should not, which it
 * may still have checked, keeps counting. The act's own event carries the
 * same `attempt` as its operation.
 */
export async function recordCode(
  tx: TenantQuery,
  session: Session,
  caller: {
    readonly presented: VerifiedSubject;
    readonly attempt?: string;
    readonly proven?: boolean;
  },
  stage: 'before' | 'after',
  refusal: CommandRefusal | undefined,
): Promise<void> {
  const attempt = caller.attempt;
  const sent = stage === 'before';
  if (attempt === undefined || (sent ? refusal !== undefined : caller.proven !== true)) return;
  if (sent) {
    await writeAuditEvent(tx, {
      actorId: session.actorId,
      command: CODE_SENT,
      operationId: attempt,
      outcome: 'applied',
      payloadDigest: payloadDigest({ command: CODE_SENT, person: session.personId }),
    });
  }
  await tx.query(
    `insert into ops.second_factor_codes (subject_digest, attempt, state) values ($1, $2, $3)`,
    [subjectDigest(caller.presented.subject), attempt, sent ? 'sent' : 'answered'],
  );
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

/** An unverified enrolment is refused while the login holds a verified factor anywhere (0064). */
export const enrolledElsewhere = async (
  tx: TenantQuery,
  caller: { readonly presented: VerifiedSubject },
  live: { readonly status: string },
): Promise<CommandRefusal | undefined> =>
  live.status !== 'verified' && (await loginHasVerifiedFactor(tx, caller.presented.subject))
    ? refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES)
    : undefined;

/** What a verify's check found: this business's live factor, or the login's held elsewhere. */
export interface CodeCheck {
  factor?: SecondFactor | undefined;
  held: readonly string[];
}

/**
 * A verify's check before the provider call: the code's shape, the wrong-code
 * lockout, then the live factor here or, with none, the digests of the
 * factors the login holds verified through any business (0064).
 */
export async function checkCode(
  tx: TenantQuery,
  session: Session,
  caller: { readonly presented: VerifiedSubject },
  code: string | undefined,
  seen: CodeCheck,
): Promise<CommandRefusal | undefined> {
  if (code === undefined) return refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
  const locked = await wrongCodeLock(tx, caller.presented.subject);
  if (locked !== undefined) return locked;
  seen.factor = await liveFactor(tx, session.personId);
  if (seen.factor !== undefined) return await enrolledElsewhere(tx, caller, seen.factor);
  seen.held = await loginVerifiedFactors(tx, caller.presented.subject);
  return seen.held.length > 0
    ? undefined
    : refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
}
