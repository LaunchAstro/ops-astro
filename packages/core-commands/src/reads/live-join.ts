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
import {
  mapTicketCondition,
  REACH,
  readScopes,
  subjectsOf,
  withSession,
} from '../../../core-records/src/index.ts';
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
    const entries = await readInbox(tx, personId, subjectsOf(session));
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  });
  return typeof outcome === 'string' ? outcome : undefined;
}

/**
 * A digest of the tasks `personId` reads now, as `inbox.read` and `taskAccess`
 * ask their read scopes (a map's grant covering its tickets, W12), with each
 * one's activity: its own row and the rows about it (comments), its planned
 * runs and their events, and what its board row derives from other rows: the
 * state and assignee it names, its Actual total (`readActualMinutes`) and the
 * gates it waits at (`awaitingApproval`), as of now, so a deadline passing
 * moves it with no write. Any change the reader can see moves it, and so does
 * a task revoked, trashed or moved to another client; undefined unless the
 * bearer still resolves to that person.
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
      personId,
      (await readTaskSpine(tx)).taskTypeId,
      business,
      records,
      parties,
    ]);
    return rows[0]?.seen ?? refuseNotFound();
  });
  return typeof outcome === 'string' ? outcome : undefined;
}

/** A map's tickets by its grants walked here (`REACH`), so a revoked map grant moves nothing. */
const SEEN = `${REACH},
       seen as (
         select t.id, t.uuid_1 as state, t.uuid_2 as assignee from public.records t
          where t.business_id = $1 and t.record_type_id = $3 and t.deleted_at is null
            and ($4::boolean or t.id = any($5::uuid[]) or t.uuid_7 = any($6::uuid[])
                 or (t.uuid_4 = any((select records from reach)::uuid[])
                     and ${mapTicketCondition('t')})))
       select encode(sha256(convert_to(coalesce(string_agg(part, ',' order by part), ''),
                'UTF8')), 'hex') as seen
         from (select r.id::text || ':' || r.revision::text from public.records r
                where r.business_id = $1 and r.deleted_at is null
                  and (r.id in (select id from seen) or r.id in (select state from seen)
                       or r.data ->> 'task' in (select id::text from seen))
               union all
               select 'a' || p.id::text || ':' || p.xmin::text from public.people p
                where p.business_id = $1 and p.id in (select assignee from seen)
               union all
               select 'm' || m.task_id::text || ':' || sum(m.minutes)::text from public.time_entries m
                where m.business_id = $1 and m.task_id in (select id from seen)
                  and m.deleted_at is null
                group by m.task_id
               union all
               select 'g' || g.id::text || ':' || g.xmin::text from public.gates g
                 join public.planned_runs run on run.business_id = g.business_id and run.id = g.run_id
                 join public.proposal_versions ver
                   on ver.business_id = g.business_id and ver.id = g.version_id
                where g.business_id = $1 and run.task_id in (select id from seen)
                  and g.state = 'pending' and g.expires_at > statement_timestamp()
                  and ver.superseded_at is null
               union all
               select 'p' || p.id::text || ':' || p.xmin::text from public.planned_runs p
                where p.business_id = $1 and p.task_id in (select id from seen)
               union all
               select 'e' || e.id::text from public.run_events e
                where e.business_id = $1 and e.task_id in (select id from seen)) as parts(part)`;
