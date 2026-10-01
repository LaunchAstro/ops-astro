// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: who may hold the board's live stream. It is the internal channel,
// as the task's own stream is (T2f): a person inside the business, never an
// external reader and never an agent, holding a live grant of some kind. It is
// asked at the join and again on every run of the board's rule, each time in
// its own transaction through `withSession`, so an ended session or a revoked
// grant closes the stream rather than leaving it open.
//
// Each run digests what the person reads now, the tasks (`boardReach`) and
// the inbox (`shownInbox`), and the stream speaks only when that changed: a
// change the caller cannot read moves nothing they are shown, and says nothing.

import { createHash } from 'node:crypto';
import { readScopes, withSession } from '../../../core-records/src/index.ts';
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
 * A digest of the tasks `personId` reads now, as `inbox.read` and `taskAccess`
 * ask their read scopes, with each one's activity: its own row and the rows
 * about it (comments), its planned runs and their events. Any change the
 * reader can see moves it, and so does a task revoked, trashed or moved to
 * another client; undefined unless the bearer still resolves to that person.
 */
export async function boardReach(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  personId: string,
): Promise<string | undefined> {
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (session.personId !== personId || !isInternalReader(session.roleKey)) {
      return refuseNotFound();
    }
    const { business, records, parties } = await readScopes(tx, personId);
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

const SEEN = `with seen as (
         select id from public.records
          where business_id = $1 and record_type_id = $2 and deleted_at is null
            and ($3::boolean or id = any($4::uuid[]) or uuid_7 = any($5::uuid[])))
       select encode(sha256(convert_to(coalesce(string_agg(part, ',' order by part), ''),
                'UTF8')), 'hex') as seen
         from (select r.id::text || ':' || r.revision::text from public.records r
                where r.business_id = $1 and r.deleted_at is null
                  and (r.id in (select id from seen)
                       or r.data ->> 'task' in (select id::text from seen))
               union all
               select 'p' || p.id::text || ':' || p.xmin::text from public.planned_runs p
                where p.business_id = $1 and p.task_id in (select id from seen)
               union all
               select 'e' || e.id::text from public.run_events e
                where e.business_id = $1 and e.task_id in (select id from seen)) as parts(part)`;
