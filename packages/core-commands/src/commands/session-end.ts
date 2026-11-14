// SPDX-License-Identifier: AGPL-3.0-only
//
// Sign-out (C23, CS-2.9): the command that causes `session ended (sign-out)`.
//
// **What it writes is the audit event, and the envelope writes it.** The
// envelope appends one event per attempt to the business's chain in this
// command's transaction, naming the actor who asked, so the handler has
// nothing of its own to store: a second table saying the same thing would be
// a second answer to "when did this person sign out" that could disagree with
// the chain.
//
// **It names nobody, so it can end nobody else's.** The request carries no
// identifier (`session.end` takes none, and a body naming a person, an actor
// or an account is refused before this runs), and the actor is the resolved
// caller.
//
// **It ends the caller's own session, here, in this transaction** (#2427), as
// the sign-out route does (`endOwnSession`: the ending keys in their order,
// the session ended in every business the login reaches), so the event the
// envelope writes beside it is true: from this commit the same bearer is
// refused at the door. Ending the credential at the identity provider is the
// sign-out route's, which the browser asks for after this; refused for an
// ended session, it still signs out there (`signOutRefused`,
// `apps/api/account-routes.ts`). A session an ending reached first is refused
// as any write of it is; a caller with no provider session named (no
// `session_id`) has nothing to end here.

import {
  ENDED_FIXES,
  endOwnSession as endSessionHere,
  holdEnding,
  sessionEnded,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

export async function endOwnSession(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const { personId, presented } = context.session;
  const sessionId = presented?.sessionId;
  if (presented !== undefined && sessionId !== undefined) {
    // The ending's keys first, in their one order (the audit chain, the
    // login's subject, then the session), so the ask and the end see one
    // state: a sign-out, a factor change through any business or a reset's
    // window (which share only the subject's key) either ended this session
    // first, and it is refused as any write, or waits for this to commit.
    await holdEnding(tx, presented.subject, [sessionId]);
    if (await sessionEnded(tx, presented)) {
      return refused(refuseCommand('AUTH_SESSION_EXPIRED', [], ENDED_FIXES));
    }
    await endSessionHere(tx, personId, sessionId);
  }
  // The envelope's last ask would find this very ending and refuse the act
  // that made it: it asks nothing more of the session (`endsOwnSession`).
  return { ...applied(null, null, { ended: 'sign-out' }), endsOwnSession: true };
}
