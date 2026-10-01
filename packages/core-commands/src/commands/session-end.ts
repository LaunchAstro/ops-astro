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
// caller. Ending the credential itself is the identity provider's, on the
// caller's own session only; the browser asks for that beside this record.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, type HandlerOutcome } from './outcome.ts';

export function endOwnSession(_tx: TenantQuery, _context: CommandContext): Promise<HandlerOutcome> {
  return Promise.resolve(applied(null, null, { ended: 'sign-out' }));
}
