// SPDX-License-Identifier: AGPL-3.0-only
//
// The mandate commands' grant (MP-14-10a), held from the envelope's check
// through commit: asked again under each command's row locks, and a last time
// once its rows are written, after the audit chain's lock, its last wait.

import {
  advisoryLock,
  sessionEndedSince,
  subjectsOf,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

export const notGranted = (): HandlerOutcome =>
  refused(
    refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['no live grant covers it', 'ask a holder who may delegate'],
    ),
  );

/** `mandate:manage` business-wide, judged at the instant the grants are held. */
export async function stillManagesMandates(
  tx: TenantQuery,
  context: CommandContext,
): Promise<boolean> {
  const subjects = subjectsOf(context.session);
  await holdCoveringGrants(tx, subjects, 'mandate');
  const at = await lockedInstant(tx);
  const decision = await checkAuthorityAt(
    tx,
    subjects,
    { collection: 'mandate', action: 'manage', scope: { kind: 'business', id: null } },
    at,
  );
  return decision.ok;
}

const SIGNED_OUT = 'sign in again: this session was signed out';
const SIGNED_OUT_KEPT =
  'The session that sent this change was signed out before it applied; nothing changed.';

/**
 * The last reads, once the command's rows are written, as
 * `automation-approvals.ts` takes them: after the audit chain's lock, the last
 * wait (the chain trigger's key, `business_id::text`, lower case), the session
 * read with its ending keys held shared to commit (`sessionEndedHeld`), so a
 * sign-out through another business either came first and refuses the command
 * or waits for it; then `mandate:manage` at that clock, so a grant that ran out
 * meanwhile refuses it. A refusal rolls the rows back with the handler's
 * savepoint, and the register keeps a sign-out as a scope refusal. Nothing when
 * it stands.
 */
export async function standsAtCommit(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome | null> {
  await advisoryLock(tx, tx.businessId.toLowerCase());
  if (await sessionEndedSince(tx, context.session)) {
    return {
      refusal: refuseCommand('AUTH_SESSION_EXPIRED', [], [SIGNED_OUT]),
      kept: refuseCommand('SCOPE_NOT_GRANTED', [], [SIGNED_OUT_KEPT]),
    };
  }
  return (await stillManagesMandates(tx, context)) ? null : notGranted();
}
