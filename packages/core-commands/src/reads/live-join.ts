// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: who may hold the board's live stream. It is the internal channel,
// as the task's own stream is (T2f): a person inside the business, never an
// external reader and never an agent, holding a live grant of some kind. It is
// asked at the join and again on every recheck and inbox signal, each time in
// its own transaction through `withSession`, so an ended session or a revoked
// grant closes the stream rather than leaving it open.

import { withSession } from '../../../core-records/src/index.ts';
import type { BusinessId, Database, VerifiedSubject } from '../../../core-records/src/index.ts';
import {
  asCallerVisible,
  isCommandRefusal,
  refuseNotFound,
  type CommandRefusal,
} from '../commands/refusal.ts';
import { readCapabilities } from './capabilities.ts';
import { isInternalReader } from './tasks.ts';

export async function joinLiveBoard(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
): Promise<{ readonly personId: string } | CommandRefusal> {
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (!isInternalReader(session.roleKey)) return refuseNotFound();
    if ((await readCapabilities(tx, session)).grants.length === 0) return refuseNotFound();
    return { personId: session.personId };
  });
  return isCommandRefusal(outcome) ? asCallerVisible(outcome) : outcome;
}
