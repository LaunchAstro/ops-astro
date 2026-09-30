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
import { readTaskSpine } from '../commands/context.ts';
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
 * task's own client, so a reader of client A hears client A and never client B;
 * never when the bearer now resolves to another person than the stream's.
 */
export async function boardHears(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  task: { readonly id: string; readonly personId: string },
): Promise<boolean> {
  const outcome = await withSession(
    database,
    businessId,
    presented,
    async (tx, session) =>
      session.personId === task.personId &&
      isInternalReader(session.roleKey) &&
      (await taskAccess(tx, session.personId, task.id)) === 'readable',
  );
  return outcome === true;
}

/**
 * A digest of the tasks the board's reader sees now: live tasks their read
 * scopes reach, as `inbox.read` and `taskAccess` ask them. A task revoked,
 * trashed or moved to another client moves it, so the board refetches.
 */
export async function boardReach(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
): Promise<string | undefined> {
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (!isInternalReader(session.roleKey)) return refuseNotFound();
    const { business, records, parties } = await readScopes(tx, session.personId);
    const rows = await tx.query<{ readonly seen: string }>(SEEN, [
      tx.businessId,
      (await readTaskSpine(tx)).taskTypeId,
      business,
      records,
      parties,
    ]);
    return rows[0]?.seen ?? refuseNotFound();
  });
  return typeof outcome === 'string' ? outcome : undefined;
}

const SEEN = `select encode(sha256(convert_to(coalesce(string_agg(id::text, ',' order by id), ''),
                'UTF8')), 'hex') as seen
         from public.records
        where business_id = $1 and record_type_id = $2 and deleted_at is null
          and ($3::boolean or id = any($4::uuid[]) or uuid_7 = any($5::uuid[]))`;
