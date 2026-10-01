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
// record under a second transaction that locks the login, then the person's
// row (`liveFactor`), and checks again, so two tabs or two businesses cannot
// enrol twice or verify a factor another has just removed. The record and its
// audit event commit together.
//
// Nothing the provider or the person sends is kept: not the authenticator
// secret or its QR code (handed to the person once, in the enrol answer, and
// nowhere else), not the code they typed, and not the provider's own words on
// a failure, which could carry anything. The audit event holds the act, its
// outcome and a digest of what identifies it.

import { randomUUID } from 'node:crypto';
import {
  liveFactor,
  loginHasVerifiedFactor,
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
  withSession,
} from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  SecondFactor,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import {
  providerRefusal,
  type FactorProvider,
  type FactorSession,
  type IssuedFactor,
  type SessionsEnded,
} from './account-factor-provider.ts';
import { endOthersOnChange, signOutOthers } from './account-factor-sessions.ts';
import { codeOf, freshSignIn, recordCode, wrongCodeLock } from './account-factor-checks.ts';
import { writeAuditEvent } from './audit.ts';
import { asCallerVisible, refuseCommand, type CommandRefusal } from './refusal.ts';

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
const BODY_FIXES: readonly string[] = ['Send only { "code": "<the six digits>" }.'];

/**
 * First enrolment: a person with no factor, after a fresh password sign-in
 * inside the step-up window (TR-A2-2). A person who already has a verified
 * factor, here or through any business the login reaches (0064), replaces it
 * by removing it first, with a code.
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
      if (await holdsVerified(tx, caller, await liveFactor(tx, session.personId)))
        return refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES);
      return (await freshSignIn(tx, session))
        ? undefined
        : refuseCommand('FRESH_SIGN_IN_REQUIRED', [], FRESH_FIXES);
    },
    'before',
  );
  if (precondition !== undefined) return precondition;

  const issued = await provider.enrol(caller.accessToken);
  const recorded = await judged(caller, act, async (tx, session) => {
    if (!issued.ok) return providerRefusal(issued.fault, 'answer');
    const live = await liveFactor(tx, session.personId, { lock: caller.presented.subject });
    if (await holdsVerified(tx, caller, live))
      return refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES);
    // An enrolment never completed is replaced, not stacked: the newest
    // unverified factor is the one the first code completes.
    if (live !== undefined) await recordFactorRemoved(tx, ownFactor(caller, session, live.id));
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
 * completes an enrolment; a wrong one is refused and recorded as failed. An
 * enrolment is not completed while the login holds a verified factor through
 * any business (0064), as it is not started then.
 */
export async function verifySecondFactor(
  caller: FactorCaller,
  body: unknown,
  provider: FactorProvider,
): Promise<(FactorSession & { readonly otherSessions?: SessionsEnded }) | CommandRefusal> {
  const act = 'account.factor_verify';
  const code = codeOf(body);
  const sending = { ...caller, attempt: randomUUID() };
  let factor: SecondFactor | undefined;
  const precondition = await judged(
    sending,
    act,
    async (tx, session) => {
      if (code === undefined) return refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
      const locked = await wrongCodeLock(tx, caller.presented.subject);
      if (locked !== undefined) return locked;
      factor = await liveFactor(tx, session.personId);
      return factor === undefined
        ? refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES)
        : await enrolledElsewhere(tx, caller, factor);
    },
    'before',
  );
  if (precondition !== undefined || factor === undefined || code === undefined)
    return precondition ?? refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
  const target = factor;

  const verified = await provider.verify(caller.accessToken, target.providerFactorId, code);
  let ended: number | undefined;
  const recorded = await judged({ ...sending, proven: verified.ok }, act, async (tx, session) => {
    if (!verified.ok) return providerRefusal(verified.fault, 'code');
    const live = await liveFactor(tx, session.personId, { lock: caller.presented.subject });
    // Removed or replaced by another tab between the two transactions.
    if (live?.id !== target.id) return refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
    const elsewhere = await enrolledElsewhere(tx, caller, live);
    if (elsewhere !== undefined) return elsewhere;
    // The first good code completes an enrolment (a factor change); a later one is a step-up.
    if (live.status !== 'verified') ended = await endOthersOnChange(tx, session, caller.presented);
    await recordFactorVerified(tx, ownFactor(caller, session, live.id));
    return undefined;
  });
  // Verified at the provider but refused here: removed there too, best effort.
  if (recorded?.code === 'FACTOR_ALREADY_ENROLLED' && verified.ok)
    await provider.remove(verified.value.accessToken, target.providerFactorId);
  if (recorded !== undefined || !verified.ok)
    return recorded ?? providerRefusal('malformed', 'answer');
  if (ended === undefined) return verified.value;
  const otherSessions = await signOutOthers(provider, verified.value.accessToken, ended);
  return { ...verified.value, otherSessions };
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
  const sending = { ...caller, attempt: randomUUID() };
  let factor: { readonly id: string; readonly providerFactorId: string } | undefined;
  const precondition = await judged(
    sending,
    act,
    async (tx, session) => {
      if (code === undefined) return refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
      const locked = await wrongCodeLock(tx, caller.presented.subject);
      if (locked !== undefined) return locked;
      const live = await liveFactor(tx, session.personId);
      if (live?.status !== 'verified')
        return refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
      factor = live;
      return undefined;
    },
    'before',
  );
  if (precondition !== undefined || factor === undefined || code === undefined)
    return precondition ?? refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
  const target = factor;

  const proved = await provider.verify(caller.accessToken, target.providerFactorId, code);
  let ended = 0;
  const removed = proved.ok
    ? await provider.remove(proved.value.accessToken, target.providerFactorId)
    : undefined;
  const recorded = await judged({ ...sending, proven: proved.ok }, act, async (tx, session) => {
    if (!proved.ok) return providerRefusal(proved.fault, 'code');
    if (removed !== undefined && !removed.ok) return providerRefusal(removed.fault, 'answer');
    const live = await liveFactor(tx, session.personId, { lock: caller.presented.subject });
    if (live?.id !== target.id) return refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
    ended = await endOthersOnChange(tx, session, caller.presented);
    await recordFactorRemoved(tx, ownFactor(caller, session, live.id));
    return undefined;
  });
  if (recorded !== undefined || !proved.ok)
    return recorded ?? providerRefusal('malformed', 'answer');
  return {
    removed: true,
    otherSessions: await signOutOthers(provider, proved.value.accessToken, ended),
  };
}

/** A verified factor here, or one the login holds through any business (0064). */
const holdsVerified = async (
  tx: TenantQuery,
  caller: FactorCaller,
  live: { readonly status: string } | undefined,
) => live?.status === 'verified' || (await loginHasVerifiedFactor(tx, caller.presented.subject));

/**
 * An enrolment here not yet completed is refused as a new one would be while
 * the login holds a verified factor through any business (0064).
 */
const enrolledElsewhere = async (
  tx: TenantQuery,
  caller: FactorCaller,
  live: { readonly status: string },
) =>
  live.status !== 'verified' && (await loginHasVerifiedFactor(tx, caller.presented.subject))
    ? refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES)
    : undefined;

/** The caller's factor, and the login's subject that holds it in every business (0064). */
const ownFactor = (caller: FactorCaller, session: Session, factorId: string) => ({
  personId: session.personId,
  factorId,
  subject: caller.presented.subject,
});

/**
 * One transaction on the factor path: resolve the caller (their factor is not
 * required yet, since these acts are how they give it), run `check`, and write
 * the act's audit event in the same transaction.
 *
 * The check before the provider call records only a refusal, or, passed for a
 * code (`attempt`), the code as sent, under the login's lock (`recordCode`);
 * the act's own event, applied or refused, is written after the call beside
 * the record it changes, and names the same `attempt`, with the code recorded
 * as answered only when the provider proved it good (`proven`).
 */
async function judged(
  caller: FactorCaller & { readonly attempt?: string; readonly proven?: boolean },
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
      await recordCode(tx, session, caller, stage, refusal);
      if (stage === 'before' && refusal === undefined) return;
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command: act,
        operationId: caller.attempt ?? null,
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
