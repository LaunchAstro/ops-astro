// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own second factor (C59): enrol it, complete it with the first
// code, and remove it with a code entered for that change.
//
// Each act is a person's, on their own account (`account:write`, own account
// only; never an agent's, so it is served on the person prefix alone), and
// each crosses to the sign-in provider, which holds the factor and its secret.
// A provider call is never made inside a database transaction, so every act is
// three steps: check under the serving transaction, call the provider, then
// record under a second transaction that locks the person's own row and
// checks again, so two tabs cannot enrol twice or verify a factor another tab
// has just removed. The record and its audit event commit together.
//
// Nothing the provider or the person sends is kept: not the authenticator
// secret or its QR code (handed to the person once, in the enrol answer, and
// nowhere else), not the code they typed, and not the provider's own words on
// a failure, which could carry anything. The audit event holds the act, its
// outcome and a digest of what identifies it.

import {
  endOtherSeenSessions,
  liveFactor,
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
  STEP_UP_WINDOW_SECONDS,
  withSession,
} from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { asCallerVisible, refuseCommand, type CommandRefusal } from './refusal.ts';

/** What can go wrong at the provider, by kind only (TR-SEC4R-5). */
export type ProviderFault = 'refused' | 'malformed' | 'oversized' | 'slow' | 'unreachable';

export type ProviderAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: ProviderFault };

/** A factor the provider has just issued. The secret goes to the person once. */
export interface IssuedFactor {
  readonly factorId: string;
  readonly qrCode: string;
  readonly secret: string;
  readonly uri: string;
}

/** The session a verified code gives: now at `aal2`. */
export interface FactorSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/** A person's other sessions ended (C58): how many here, and whether the provider confirmed. */
export interface SessionsEnded {
  readonly ended: number;
  readonly signedOutAtProvider: boolean;
}

/**
 * The provider's calls made with the person's own token: the three
 * second-factor calls, and signing out (C58), of this session (`local`) or of
 * every other (`others`), which revokes those sessions' refresh tokens.
 */
export interface FactorProvider {
  enrol(accessToken: string): Promise<ProviderAnswer<IssuedFactor>>;
  verify(
    accessToken: string,
    factorId: string,
    code: string,
  ): Promise<ProviderAnswer<FactorSession>>;
  remove(accessToken: string, factorId: string): Promise<ProviderAnswer<void>>;
  signOut(accessToken: string, scope: 'local' | 'others'): Promise<ProviderAnswer<void>>;
}

/** Who is asking and what they presented, as the API door admitted them. */
export interface FactorCaller {
  readonly database: Database;
  readonly businessId: BusinessId;
  readonly presented: VerifiedSubject;
  /** The person's own bearer, passed to the provider and nowhere else. */
  readonly accessToken: string;
}

type Act = 'account.factor_enrol' | 'account.factor_verify' | 'account.factor_remove';

const FRESH_FIXES: readonly string[] = [
  'Sign in again with your password, then set up the authenticator app within 60 minutes.',
];
const ENROLLED_FIXES: readonly string[] = [
  'You already have an authenticator app. To replace it, remove it with a code from it first.',
];
const NOT_ENROLLED_FIXES: readonly string[] = ['Set up an authenticator app first.'];
const CODE_FIXES: readonly string[] = [
  'Enter the six-digit code your authenticator app shows now.',
];
const PROVIDER_FIXES: readonly string[] = [
  'The sign-in service did not answer as expected. Nothing was changed; try again shortly.',
];
const BODY_FIXES: readonly string[] = ['Send only { "code": "<the six digits>" }.'];
const LOCKED_FIXES: readonly string[] = [
  'Too many wrong codes. Wait 15 minutes, then try again with the code your app shows.',
];

/**
 * Wrong codes a person may send before their factor routes stop asking the
 * provider: five in fifteen minutes, counted from their own refused attempts
 * in the audit chain, so a six-digit code cannot be walked by a caller who
 * holds only the password.
 */
const FAILED_CODE_LIMIT = 5;
const FAILED_CODE_WINDOW_MINUTES = 15;

/**
 * First enrolment: a person with no factor, after a fresh password sign-in
 * inside the step-up window (TR-A2-2). A person who already has a verified
 * factor replaces it by removing it first, with a code.
 */
export async function enrolSecondFactor(
  caller: FactorCaller,
  provider: FactorProvider,
): Promise<IssuedFactor | CommandRefusal> {
  const act = 'account.factor_enrol';
  const precondition = await judged(
    caller,
    act,
    async (tx, session) => {
      const live = await liveFactor(tx, session.personId);
      if (live?.status === 'verified')
        return refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES);
      if (!(await freshSignIn(tx, session)))
        return refuseCommand('FRESH_SIGN_IN_REQUIRED', [], FRESH_FIXES);
      return undefined;
    },
    'before',
  );
  if (precondition !== undefined) return precondition;

  const issued = await provider.enrol(caller.accessToken);
  const recorded = await judged(caller, act, async (tx, session) => {
    if (!issued.ok) return providerRefusal(issued.fault, 'answer');
    const live = await liveFactor(tx, session.personId, { lock: true });
    if (live?.status === 'verified')
      return refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES);
    // An enrolment never completed is replaced, not stacked: the newest
    // unverified factor is the one the first code completes.
    if (live !== undefined) {
      await recordFactorRemoved(tx, { personId: session.personId, factorId: live.id });
    }
    await recordFactorEnrolled(tx, {
      personId: session.personId,
      provider: caller.presented.provider,
      providerFactorId: issued.value.factorId,
    });
    return undefined;
  });
  if (recorded !== undefined || !issued.ok)
    return recorded ?? providerRefusal('malformed', 'answer');
  return issued.value;
}

/**
 * A code checked against the person's live factor. The first good code
 * completes an enrolment; a wrong one is refused and recorded as failed.
 */
export async function verifySecondFactor(
  caller: FactorCaller,
  body: unknown,
  provider: FactorProvider,
): Promise<(FactorSession & { readonly otherSessions?: SessionsEnded }) | CommandRefusal> {
  const act = 'account.factor_verify';
  const code = codeOf(body);
  let factor: { readonly id: string; readonly providerFactorId: string } | undefined;
  const precondition = await judged(
    caller,
    act,
    async (tx, session) => {
      if (code === undefined) return refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
      if (await tooManyWrongCodes(tx, session))
        return refuseCommand('SECOND_FACTOR_LOCKED', [], LOCKED_FIXES);
      factor = await liveFactor(tx, session.personId);
      return factor === undefined
        ? refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES)
        : undefined;
    },
    'before',
  );
  if (precondition !== undefined || factor === undefined || code === undefined) {
    return precondition ?? refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
  }
  const target = factor;

  const verified = await provider.verify(caller.accessToken, target.providerFactorId, code);
  let ended: number | undefined;
  const recorded = await judged(caller, act, async (tx, session) => {
    if (!verified.ok) return providerRefusal(verified.fault, 'code');
    const live = await liveFactor(tx, session.personId, { lock: true });
    // Removed or replaced by another tab between the two transactions.
    if (live?.id !== target.id) return refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
    // The first good code completes an enrolment, which is a factor change;
    // a later one is a step-up and changes nothing.
    if (live.status !== 'verified') ended = await endOthersOnChange(tx, session, caller);
    await recordFactorVerified(tx, { personId: session.personId, factorId: live.id });
    return undefined;
  });
  if (recorded !== undefined || !verified.ok)
    return recorded ?? providerRefusal('malformed', 'answer');
  if (ended === undefined) return verified.value;
  return {
    ...verified.value,
    otherSessions: await signOutOthers(provider, verified.value.accessToken, ended),
  };
}

/**
 * Removing the verified factor: the current code, entered for this change,
 * checked by the provider first, and the removal made with the `aal2`
 * session that check returns (TR-A2-2; the factor's own protection, not the
 * money re-check).
 */
export async function removeSecondFactor(
  caller: FactorCaller,
  body: unknown,
  provider: FactorProvider,
): Promise<{ readonly removed: true; readonly otherSessions: SessionsEnded } | CommandRefusal> {
  const act = 'account.factor_remove';
  const code = codeOf(body);
  let factor: { readonly id: string; readonly providerFactorId: string } | undefined;
  const precondition = await judged(
    caller,
    act,
    async (tx, session) => {
      if (code === undefined) return refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
      if (await tooManyWrongCodes(tx, session))
        return refuseCommand('SECOND_FACTOR_LOCKED', [], LOCKED_FIXES);
      const live = await liveFactor(tx, session.personId);
      if (live?.status !== 'verified')
        return refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
      factor = live;
      return undefined;
    },
    'before',
  );
  if (precondition !== undefined || factor === undefined || code === undefined) {
    return precondition ?? refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
  }
  const target = factor;

  const proved = await provider.verify(caller.accessToken, target.providerFactorId, code);
  let ended = 0;
  const removed = proved.ok
    ? await provider.remove(proved.value.accessToken, target.providerFactorId)
    : undefined;
  const recorded = await judged(caller, act, async (tx, session) => {
    if (!proved.ok) return providerRefusal(proved.fault, 'code');
    if (removed !== undefined && !removed.ok) return providerRefusal(removed.fault, 'answer');
    const live = await liveFactor(tx, session.personId, { lock: true });
    if (live?.id !== target.id) return refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
    ended = await endOthersOnChange(tx, session, caller);
    await recordFactorRemoved(tx, { personId: session.personId, factorId: live.id });
    return undefined;
  });
  if (recorded !== undefined || !proved.ok)
    return recorded ?? providerRefusal('malformed', 'answer');
  return {
    removed: true,
    otherSessions: await signOutOthers(provider, proved.value.accessToken, ended),
  };
}

/**
 * A factor change ends the person's other sessions (C58): here, in
 * the change's own transaction, so they are refused from its commit.
 */
async function endOthersOnChange(
  tx: TenantQuery,
  session: Session,
  caller: FactorCaller,
): Promise<number> {
  return await endOtherSeenSessions(
    tx,
    session.personId,
    caller.presented.sessionId,
    'factor_change',
  );
}

/**
 * Then at the provider, with the session the code has just raised (the one
 * kept), which revokes every other session's refresh tokens. After the
 * commit: the change stands whatever the provider answers, and the answer
 * says whether it confirmed.
 */
async function signOutOthers(
  provider: FactorProvider,
  accessToken: string,
  ended: number,
): Promise<SessionsEnded> {
  const signedOut = await provider.signOut(accessToken, 'others');
  return { ended, signedOutAtProvider: signedOut.ok };
}

/**
 * One transaction on the factor path: resolve the caller (their factor is not
 * required yet, since these acts are how they give it), run `check`, and write
 * the act's audit event in the same transaction.
 *
 * The check before the provider call records only a refusal: a check that
 * passed has done nothing yet, and the act's own event is the one written
 * after the call, applied or refused, beside the record it changes.
 */
async function judged(
  caller: FactorCaller,
  act: Act,
  check: (tx: TenantQuery, session: Session) => Promise<CommandRefusal | undefined>,
  stage: 'before' | 'after' = 'after',
): Promise<CommandRefusal | undefined> {
  const outcome = await withSession(
    caller.database,
    caller.businessId,
    caller.presented,
    async (tx, session) => {
      const refusal = await check(tx, session);
      if (stage === 'before' && refusal === undefined) return undefined;
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command: act,
        outcome: refusal === undefined ? 'applied' : 'refused',
        refusalCode: refusal?.code ?? null,
        payloadDigest: payloadDigest({ command: act, person: session.personId }),
      });
      return refusal;
    },
    'enrolling',
  );
  if (outcome === undefined) return undefined;
  return asCallerVisible(outcome);
}

/** Whether this person has sent too many wrong codes lately (see `FAILED_CODE_LIMIT`). */
async function tooManyWrongCodes(tx: TenantQuery, session: Session): Promise<boolean> {
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
async function freshSignIn(tx: TenantQuery, session: Session): Promise<boolean> {
  const signedInAt = session.assurance.signedInAt;
  if (signedInAt === null) return false;
  const rows = await tx.query<{ readonly now: number }>(
    'select floor(extract(epoch from now()))::float8 as now',
  );
  const age = (rows[0]?.now ?? Number.POSITIVE_INFINITY) - signedInAt;
  return age <= STEP_UP_WINDOW_SECONDS && age >= -60;
}

/** `{ "code": "123456" }` and nothing else: six digits, as authenticator apps show. */
function codeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  const code = (body as Readonly<Record<string, unknown>>)['code'];
  if (keys.length !== 1 || typeof code !== 'string' || !/^[0-9]{6}$/u.test(code)) return undefined;
  return code;
}

/**
 * A provider's no to a code is a wrong code, recorded as the failed attempt;
 * any other fault, and a no to anything but a code, is the provider's answer
 * refused, by its kind alone.
 */
function providerRefusal(fault: ProviderFault, asked: 'code' | 'answer'): CommandRefusal {
  return fault === 'refused' && asked === 'code'
    ? refuseCommand('SECOND_FACTOR_INVALID', [], CODE_FIXES)
    : refuseCommand('PROVIDER_ANSWER_INVALID', [fault], PROVIDER_FIXES);
}
