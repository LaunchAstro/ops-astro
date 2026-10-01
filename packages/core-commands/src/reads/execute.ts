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

import { withSession, withStanding } from '../../../core-records/src/index.ts';
import type { BusinessId, Database, VerifiedSubject } from '../../../core-records/src/index.ts';
import { asCallerVisible, isCommandRefusal, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadRequest, ReadResult } from './requests.ts';
import { admitRead, runRead } from './dispatch.ts';
import { isInternalReader } from './tasks.ts';

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
  if (isCommandRefusal(outcome)) return asCallerVisible(outcome);
  return outcome;
}

/** Where an admission is asked: when a stream is opened, or again on it. */
export type AdmissionAt = 'door' | 'recheck';

/**
 * Whether the session may make each read, as `executeRead` would decide it,
 * in one transaction and without serving or auditing any of them.
 *
 * For the live channel, whose checks show the person nothing (C4 live-sync 6).
 * At the `door` the login is resolved as every request's is, and its one
 * authentication attempt is recorded; a `recheck` resolves the same standing
 * and records nothing. A refused login is the one answer for every read.
 */
export async function admitReads(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  requests: readonly ReadRequest[],
  at: AdmissionAt,
): Promise<readonly Admission[] | CommandRefusal> {
  const within = at === 'door' ? withSession : withStanding;
  const outcome = await within(database, businessId, presented, async (tx, session) => {
    const admissions: Admission[] = [];
    for (const request of requests) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time.
      const admitted = await admitRead(tx, session, request);
      admissions.push(isCommandRefusal(admitted) ? asCallerVisible(admitted) : admitted);
    }
    return admissions;
  });
  return isCommandRefusal(outcome) ? asCallerVisible(outcome) : outcome;
}

/** Who a live-channel caller is, for presence (C2): staff or not, and the name teammates see. */
export interface Viewer {
  readonly personId: string;
  readonly name: string;
  readonly staff: boolean;
}

/**
 * The caller's standing, resolved as a `recheck` resolves it: nothing is
 * recorded. For presence on a stream already admitted at the door, and for
 * the presence routes, which show nothing and store nothing (C2).
 */
export async function viewerOf(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
): Promise<Viewer | CommandRefusal> {
  const outcome = await withStanding(database, businessId, presented, async (tx, session) => {
    const [person] = await tx.query<{ readonly display_name: string }>(
      'select display_name from public.people where business_id = $1 and id = $2',
      [tx.businessId, session.personId],
    );
    return {
      personId: session.personId,
      name: person?.display_name ?? '',
      staff: isInternalReader(session.roleKey),
    };
  });
  return isCommandRefusal(outcome) ? asCallerVisible(outcome) : outcome;
}

/** One read admitted, and the record it is about; or the refusal it would have met. */
export type Admission = { readonly recordId: string | undefined } | CommandRefusal;
