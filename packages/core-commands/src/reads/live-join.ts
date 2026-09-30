// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: who may hold the board's live stream. It is the internal channel,
// as the task's own stream is (T2f): a person inside the business, never an
// external reader and never an agent, holding a live grant of some kind. It is
// asked at the join and again on every recheck and inbox signal, each time in
// its own transaction through `withSession`, so an ended session or a revoked
// grant closes the stream rather than leaving it open.
//
// The inbox topic is the person's own and says nothing of which item moved,
// so the stream asks what `inbox.read` shows that person now (`shownInbox`)
// and speaks only when that changed: an item about a task the caller cannot
// read moves nothing they are shown, and says nothing.

import { createHash } from 'node:crypto';
import { readScopes, taskAccess, withSession } from '../../../core-records/src/index.ts';
import type { BusinessId, Database, VerifiedSubject } from '../../../core-records/src/index.ts';
import {
  asCallerVisible,
  isCommandRefusal,
  refuseNotFound,
  type CommandRefusal,
} from '../commands/refusal.ts';
import { readCapabilities } from './capabilities.ts';
import { readInbox } from './inbox.ts';
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

/**
 * A digest of what `inbox.read` shows `personId` now, read in its own
 * transaction; undefined unless the bearer still resolves to that same person,
 * an internal reader, so a remapped login is never shown another's inbox.
 */
export async function shownInbox(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  personId: string,
): Promise<string | undefined> {
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (session.personId !== personId || !isInternalReader(session.roleKey)) {
      return refuseNotFound();
    }
    const entries = await readInbox(tx, personId);
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  });
  return typeof outcome === 'string' ? outcome : undefined;
}

/**
 * Whether the board may tell its reader that one task moved (INB-1 35), by the
 * grants `inbox.read` asks: the business, the task, or a party grant on the
 * task's own client, so a reader of client A hears client A and never client B.
 * `'gone'`: trashed while the reader still holds read on it.
 */
export async function boardHears(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  taskId: string,
): Promise<boolean | 'gone'> {
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (!isInternalReader(session.roleKey)) return false;
    const access = await taskAccess(tx, session.personId, taskId);
    if (access === 'readable') return true;
    // A row no longer there is `gone` to anyone; it says nothing here.
    const rows = await tx.query(`select 1 from public.records where business_id = $1 and id = $2`, [
      tx.businessId,
      taskId,
    ]);
    return access === 'gone' && rows.length > 0 ? 'gone' : false;
  });
  return outcome === true || outcome === 'gone' ? outcome : false;
}

/**
 * A digest of where the board's reader reads tasks now, the scopes `inbox.read`
 * asks (the business, each task, each client): any revoked read moves it.
 */
export async function boardReach(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
): Promise<string | undefined> {
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (!isInternalReader(session.roleKey)) return refuseNotFound();
    const { business, records, parties } = await readScopes(tx, session.personId);
    const scopes = [business, records.toSorted(), parties.toSorted()];
    return createHash('sha256').update(JSON.stringify(scopes)).digest('hex');
  });
  return typeof outcome === 'string' ? outcome : undefined;
}
