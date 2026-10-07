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
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
} from '../../../core-records/src/index.ts';
import type { SecondFactor, Session, TenantQuery } from '../../../core-records/src/index.ts';
import {
  providerRefusal,
  type FactorProvider,
  type FactorSession,
  type IssuedFactor,
  type SessionsEnded,
} from './account-factor-provider.ts';
import {
  holdsVerified,
  ownFactor,
  removeAtProvider,
  reportOrphan,
} from './account-factor-orphan.ts';
import { heldElsewhere, stillHeld, type CodeTarget } from './account-factor-elsewhere.ts';
import { endOthersOnChange, signOutOthers } from './account-factor-sessions.ts';
import {
  BODY_FIXES,
  checkCode,
  codeOf,
  ENROLLED_FIXES,
  enrolledElsewhere,
  freshSignIn,
  NOT_ENROLLED_FIXES,
  wrongCodeLock,
  type CodeCheck,
} from './account-factor-checks.ts';
import { judged, type FactorCaller } from './account-factor-judged.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

export type { FactorCaller } from './account-factor-judged.ts';

const FRESH_FIXES: readonly string[] = [
  'Sign in again with your password, then set up the authenticator app within 60 minutes.',
];
const NEWER_FIXES: readonly string[] = [
  'A newer set-up started while this one was on its way. Use the newest, or start again.',
];

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
  // An operation id, not a code `attempt`: no code is sent, so none counts.
  const sending = { ...caller, operation: randomUUID() };
  // The live factor this enrolment starts from: only that one may it replace.
  let startedFrom: string | undefined;
  const precondition = await judged(
    sending,
    act,
    async (tx, session) => {
      const live = await liveFactor(tx, session.personId);
      if (await holdsVerified(tx, caller, live))
        return refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES);
      startedFrom = live?.id;
      return (await freshSignIn(tx, session))
        ? undefined
        : refuseCommand('FRESH_SIGN_IN_REQUIRED', [], FRESH_FIXES);
    },
    'before',
  );
  if (precondition !== undefined) return precondition;

  const issued = await provider.enrol(caller.accessToken);
  const recorded = await judged(sending, act, async (tx, session) => {
    if (!issued.ok) return providerRefusal(issued.fault, 'answer');
    const live = await liveFactor(tx, session.personId, { lock: caller.presented.subject });
    if (await holdsVerified(tx, caller, live))
      return refuseCommand('FACTOR_ALREADY_ENROLLED', [], ENROLLED_FIXES);
    // A newer one, recorded since that check, stays the target; this one is a stray.
    if (live !== undefined && live.id !== startedFrom)
      return refuseCommand('VERSION_STALE', [], NEWER_FIXES);
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
  if (!issued.ok) return recorded ?? providerRefusal('malformed', 'answer');
  // Issued there, refused here: the factor stays at the provider, reported (#300).
  const stray = { providerFactorId: issued.value.factorId };
  if (recorded !== undefined) await reportOrphan(caller, stray, sending.operation, recorded.code);
  return recorded ?? issued.value;
}

/**
 * A code checked against the person's live factor. The first good code
 * completes an enrolment; a wrong one is refused and recorded as failed. An
 * enrolment is not completed while the login holds a verified factor through
 * any business (0064), as it is not started then. With no factor here, the
 * code is checked against the one the login verified through another
 * business (`account-factor-elsewhere.ts`), which sign-in asks for here too.
 */
export async function verifySecondFactor(
  caller: FactorCaller,
  body: unknown,
  provider: FactorProvider,
): Promise<(FactorSession & { readonly otherSessions?: SessionsEnded }) | CommandRefusal> {
  const act = 'account.factor_verify';
  const code = codeOf(body);
  const sending = { ...caller, attempt: randomUUID() };
  const seen: CodeCheck = { held: [] };
  const precondition = await judged(
    sending,
    act,
    (tx, session) => checkCode(tx, session, caller, code, seen),
    'before',
  );
  if (precondition !== undefined || code === undefined)
    return precondition ?? refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
  const found = seen.factor ?? (await heldElsewhere(caller, provider, seen.held));
  if (found === undefined || 'code' in found) {
    const refused = found ?? refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
    return (await judged(sending, act, () => Promise.resolve(refused))) ?? refused;
  }
  const target = found;
  const verified = await provider.verify(caller.accessToken, target.providerFactorId, code);
  let settled: VerifyRecord = {};
  const recorded = await judged({ ...sending, proven: verified.ok }, act, async (tx, session) => {
    if (!verified.ok) return providerRefusal(verified.fault, 'code');
    settled = await recordVerify(tx, session, caller, target);
    return settled.refusal;
  });
  // A session ended during the record step's waits undoes what it decided
  // (`judged`): no losing enrolment was removed, so none goes at the provider.
  const { ended, unrecorded = false }: VerifyRecord =
    recorded?.code === 'AUTH_SESSION_EXPIRED' ? {} : settled;
  // No other refusal removes at the provider. A good code for an unverified factor
  // refused here leaves it verified there, reported orphaned; reconcile is #300.
  // An enrolment replaced by a newer one (enrolSecondFactor) is not reported.
  if (unrecorded && verified.ok)
    await removeAtProvider(caller, provider, verified.value, target, sending.attempt);
  else if (verified.ok && recorded !== undefined && target.status !== 'verified')
    await reportOrphan(caller, target, sending.attempt, recorded.code);
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
  const recorded = await judged({ ...sending, proven: proved.ok }, act, async (tx, session) => {
    if (!proved.ok) return providerRefusal(proved.fault, 'code');
    const live = await liveFactor(tx, session.personId, { lock: caller.presented.subject });
    if (live?.id !== target.id) return refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES);
    ended = await endOthersOnChange(tx, session, caller.presented);
    await recordFactorRemoved(tx, ownFactor(caller, session, live.id));
    return undefined;
  });
  if (recorded !== undefined || !proved.ok)
    return recorded ?? providerRefusal('malformed', 'answer');
  // Only once the record commits; a refusal here removes nothing there.
  await removeAtProvider(caller, provider, proved.value, target, sending.attempt);
  return {
    removed: true,
    otherSessions: await signOutOthers(provider, proved.value.accessToken, ended),
  };
}

/** What a verify's record step decided, under the login's lock. */
interface VerifyRecord {
  readonly refusal?: CommandRefusal;
  /** This call's unverified enrolment lost to a verified factor elsewhere, and was ended here. */
  readonly unrecorded?: boolean;
  /** The other sessions a completed enrolment ended; unset for a step-up or a refusal. */
  readonly ended?: number | undefined;
}

/**
 * A verify's record step, run inside `judged` under the login's lock after the
 * provider proved the code: the live factor is locked and checked again, then
 * the factor is recorded verified, or this call's losing enrolment removed.
 */
async function recordVerify(
  tx: TenantQuery,
  session: Session,
  caller: FactorCaller,
  target: CodeTarget,
): Promise<VerifyRecord> {
  const live = await liveFactor(tx, session.personId, { lock: caller.presented.subject });
  // One held elsewhere is checked again: still none here, and not removed there meanwhile.
  if (target.id === undefined)
    return live === undefined && (await stillHeld(tx, caller, target))
      ? {}
      : { refusal: refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES) };
  // Removed or replaced by another tab between the two transactions.
  if (live?.id !== target.id)
    return { refusal: refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES) };
  const elsewhere = await enrolledElsewhere(tx, caller, live);
  // Decided under the lock: this call's unverified enrolment lost, so it goes,
  // ended here first so no later code can record it verified (review r11-1).
  const unrecorded = elsewhere !== undefined;
  if (unrecorded) await recordFactorRemoved(tx, ownFactor(caller, session, live.id));
  if (elsewhere !== undefined) return { refusal: elsewhere, unrecorded };
  // The first good code completes an enrolment (a factor change); a later one is a step-up.
  let ended: number | undefined;
  if (live.status !== 'verified') ended = await endOthersOnChange(tx, session, caller.presented);
  await recordFactorVerified(tx, ownFactor(caller, session, live.id));
  return { unrecorded, ended };
}
