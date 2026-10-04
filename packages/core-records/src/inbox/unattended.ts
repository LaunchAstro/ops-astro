// SPDX-License-Identifier: AGPL-3.0-only
//
// `unattended` (INB-1e, CS-16.10): an open item that no path reaches, so a
// broken delivery path reads as a state and never as quiet. A finished run's
// item asks no response and is not counted, but a person who can no longer be
// reached about it is still a path broken, so it is listed too.
//
// A path is one recipient of the obligation who can sign in (the three facts
// login resolution asks: an active login, standing as a member or on a share,
// and an active acting identity), can read the task, and for a decision still
// holds `task:decide` on it, since a decider without authority is no path to
// the decision. An escalated gate is decided only with decide across the
// business (T3a), so for its decision that is the grant asked. In-app is the
// only channel on this head and it is always on, so a recipient who signs in
// and reads is reached; an email path joins with AW-07b. A decision or an
// incident is one obligation shared by everyone raised an item on it, and any
// one of them keeps it attended. Anything else is its recipient's own.
//
// Reached only by breaking every path, never inferred: the state is derived
// from those stored facts at every read, as access is (`items.ts`), and never
// from time, silence, an unseen stamp or a delivery attempt. So it changes the
// moment the transition that breaks or restores the last path commits, and no
// worker computes it. A trashed task's items are gone, not unattended.
//
// Escalation is parked (the owner, C33-1): no fallback person is named, this
// read raises nothing for anyone, and it writes no item, grant or decision.
// The list is the operations view's (C55) and the API's and the command
// line's `inbox.unattended`, both behind `operations:read`.

import { standsOnShares } from '../identity/login-resolution.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  holdsAcrossBusiness,
  holdsOnTask,
  INTERNAL_ROLE_KEYS,
  REACH,
  readsThroughMap,
} from './access.ts';
import { HELD } from './read.ts';
import { mapTicketCondition, wayfinderCondition } from '../tasks/wayfinder.ts';
import type { InboxFactKind, InboxReason } from './items.ts';

export interface UnattendedItem {
  readonly id: string;
  readonly recipientPersonId: string;
  readonly subjectRecordId: string;
  readonly reason: InboxReason;
  readonly factKind: InboxFactKind;
  readonly factId: string;
  readonly raisedAt: Date;
}

/** The reasons whose obligation any one of its recipients discharges. */
const SHARED: ReadonlySet<InboxReason> = new Set(['decision', 'incident']);

type OpenRow = UnattendedItem & {
  readonly clientId: string | null;
  /** The task's map when it was a map's ticket at the list's read (W12), else null. */
  readonly mapId: string | null;
  /** A map or map ticket, which the client view never reaches (WF-1). */
  readonly wayfinder: boolean;
  /** Null without an active membership, else whether its role reads as staff. */
  readonly internal: boolean | null;
  readonly loginAndActor: boolean;
  readonly escalated: boolean;
};

/**
 * Every unattended item of this business whose task the viewer can read now.
 * The viewer's read scopes, walked in the same statement (`REACH`), filter it,
 * so no row of a task they cannot read (another client's) is ever returned to
 * this read: that is the client separation, and the business's is the tenancy every query runs under.
 * The inbox's own rule (`HELD`) decides it: a map grant covers its tickets, and a viewer shown
 * the client view is returned no map or map ticket (WF-1), as their `task.read`.
 */
export async function readUnattended(
  tx: TenantQuery,
  viewerPersonId: string,
): Promise<readonly UnattendedItem[]> {
  const rows = await tx.query<OpenRow>(
    `${REACH}
     select i.id, i.recipient_person_id as "recipientPersonId",
            i.subject_record_id as "subjectRecordId", i.reason, i.fact_kind as "factKind",
            i.fact_id as "factId", i.raised_at as "raisedAt", r.uuid_7 as "clientId",
            case when ${mapTicketCondition('r')} then r.uuid_4 end as "mapId",
            ${wayfinderCondition('r')} as wayfinder,
            (select bool_or(m.role_key = any($3::text[])) from public.memberships m
              where m.business_id = i.business_id and m.person_id = i.recipient_person_id
                and m.active) as internal,
            exists (select 1 from public.person_logins pl
                     where pl.business_id = i.business_id and pl.person_id = i.recipient_person_id
                       and pl.active)
            and exists (select 1 from public.actors a
                         where a.business_id = i.business_id and a.person_id = i.recipient_person_id
                           and a.kind = 'person' and a.active) as "loginAndActor",
            -- Read through the row as decide.ts reads it: a database short of
            -- the 0041 column has no escalated gate.
            i.fact_kind = 'gate'
            and exists (select 1 from public.gates g
                         where g.business_id = i.business_id and g.id = i.fact_id
                           and (to_jsonb(g) ->> 'escalated_at') is not null) as escalated
       from public.inbox_items i
       join public.records r
         on r.business_id = i.business_id and r.id = i.subject_record_id and r.deleted_at is null
      where i.business_id = $1 and i.work_state = 'open' and ${HELD}
      order by i.raised_at, i.id`,
    [tx.businessId, viewerPersonId, INTERNAL_ROLE_KEYS],
  );
  const attended = new Set<string>();
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop
    if (!attended.has(obligationOf(row)) && (await reaches(tx, row))) {
      attended.add(obligationOf(row));
    }
  }
  const unattended: UnattendedItem[] = [];
  for (const row of rows) {
    if (attended.has(obligationOf(row))) continue;
    const { id, recipientPersonId, subjectRecordId, reason, factKind, factId, raisedAt } = row;
    unattended.push({ id, recipientPersonId, subjectRecordId, reason, factKind, factId, raisedAt });
  }
  return unattended;
}

function obligationOf(item: UnattendedItem): string {
  return SHARED.has(item.reason)
    ? `${item.subjectRecordId}/${item.reason}/${item.factKind}/${item.factId}`
    : item.id;
}

/**
 * One recipient's path: they sign in, read the task, and decide a decision,
 * an escalated gate's across the business. A recipient shown the client view
 * reads no map or map ticket (WF-1), so their inbox withholds it, as `taskAccess`.
 */
async function reaches(tx: TenantQuery, row: OpenRow): Promise<boolean> {
  if (!row.loginAndActor) return false;
  if (row.internal === null && !(await standsOnShares(tx, row.recipientPersonId))) return false;
  if (row.wayfinder && row.internal !== true) return false;
  const task = { id: row.subjectRecordId, clientId: row.clientId };
  if (
    !(await holdsOnTask(tx, row.recipientPersonId, task, 'read')) &&
    !(row.mapId !== null && (await readsThroughMap(tx, row.recipientPersonId, task.id)))
  ) {
    return false;
  }
  if (row.reason !== 'decision') return true;
  // task.decide is authorised on the task itself (GATE_TASK), so its map's decide grant is no path.
  return row.escalated
    ? await holdsAcrossBusiness(tx, row.recipientPersonId, 'decide')
    : await holdsOnTask(tx, row.recipientPersonId, task, 'decide');
}
