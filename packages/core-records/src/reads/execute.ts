// SPDX-License-Identifier: AGPL-3.0-only
//
// The whole of a read call: open the transaction, set the business, resolve the
// login, then read.
//
// It is `withSession`, the same entry the commands use, and that is the point
// rather than a convenience. The business comes from the caller's path and is
// verified against the login mapping inside the transaction; the actor is the
// server's; and the grant check in `runRead` happens in that same transaction,
// so a grant revoked a moment ago bites on this call rather than soon.
//
// A login that resolves to no standing never reaches a read at all: it is
// `AUTH_NO_MEMBERSHIP` from the resolution, which is a refusal and not an empty
// list. Standing is a membership, or for an external party a live share (R4).
// That is what arms `session.capabilities`, the one read that asks the grant
// model nothing, and this entry is where standing is established rather than
// assumed.
//
// Nothing here branches on which read it is. Every read added to
// `reads/requests.ts` and served in `reads/dispatch.ts` reaches the database
// through this one function, so arming a new one is a declaration and a case
// rather than a fourth place to edit.

import type { BusinessId, Database } from '../tenancy/database.ts';
import type { VerifiedSubject } from '../identity/login-resolution.ts';
import { withSession } from '../identity/login-resolution.ts';
import {
  asCallerVisible,
  fromIdentity,
  isCommandRefusal,
  isIdentityRefusal,
  type CommandRefusal,
} from '../commands/refusal.ts';
import type { ReadRequest, ReadResult } from './requests.ts';
import { runRead } from './dispatch.ts';

export async function executeRead(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  request: ReadRequest,
): Promise<ReadResult | CommandRefusal> {
  const outcome = await withSession(
    database,
    businessId,
    presented,
    async (tx, session) => await runRead(tx, session, request),
  );
  if (isIdentityRefusal(outcome)) return asCallerVisible(fromIdentity(outcome));
  return outcome;
}

/** The discriminant a caller reads a read result through. */
export function isReadRefusal(value: ReadResult | CommandRefusal): value is CommandRefusal {
  return isCommandRefusal(value);
}
