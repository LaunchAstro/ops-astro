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
// the decision. In-app is the only channel on this head and it is always on,
// so a recipient who signs in and reads is reached; an email path joins with
// AW-07b. A decision or an incident is one obligation shared by everyone
// raised an item on it, and any one of them keeps it attended. Anything else
// is its recipient's own.
//
// Reached only by breaking every path, never inferred: the state is derived
// from those stored facts at every read, as access is (`items.ts`), and never
// from time, silence, an unseen stamp or a delivery attempt. So it changes the
// moment the transition that breaks or restores the last path commits, and no
// worker computes it. A trashed task's items are gone, not unattended.
//
// Escalation is parked (the owner, C33-1): no fallback person is named, this
// read raises nothing for anyone, and it writes no item, grant or decision.
// The list is the operations view's (C55) and, until that lands, the API's
// and the command line's `inbox.unattended`, behind `operations:read`.

import { standsOnShares } from '../identity/login-resolution.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { holdsOnTask, readScopes, type InboxFactKind, type InboxReason } from './items.ts';

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
  readonly member: boolean;
  readonly loginAndActor: boolean;
};

/**
 * Every unattended item of this business whose task the viewer can read now.
 * The viewer's read scopes filter inside the query, so no row of a task they
 * cannot read (another client's) is ever returned to this read: that is the
 * client separation, and the business's is the tenancy every query runs under.
 */
export async function readUnattended(
  tx: TenantQuery,
  viewerPersonId: string,
): Promise<readonly UnattendedItem[]> {
  const viewer = await readScopes(tx, viewerPersonId);
  const rows = await tx.query<OpenRow>(
    `select i.id, i.recipient_person_id as "recipientPersonId",
            i.subject_record_id as "subjectRecordId", i.reason, i.fact_kind as "factKind",
            i.fact_id as "factId", i.raised_at as "raisedAt", r.uuid_7 as "clientId",
            exists (select 1 from public.memberships m
                     where m.business_id = i.business_id and m.person_id = i.recipient_person_id
                       and m.active) as member,
            exists (select 1 from public.person_logins pl
                     where pl.business_id = i.business_id and pl.person_id = i.recipient_person_id
                       and pl.active)
            and exists (select 1 from public.actors a
                         where a.business_id = i.business_id and a.person_id = i.recipient_person_id
                           and a.kind = 'person' and a.active) as "loginAndActor"
       from public.inbox_items i
       join public.records r
         on r.business_id = i.business_id and r.id = i.subject_record_id and r.deleted_at is null
      where i.business_id = $1 and i.work_state = 'open'
        and ($2::boolean or r.id = any($3::uuid[]) or r.uuid_7 = any($4::uuid[]))
      order by i.raised_at, i.id`,
    [tx.businessId, viewer.business, viewer.records, viewer.parties],
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

/** One recipient's path: they sign in, read the task, and decide a decision. */
async function reaches(tx: TenantQuery, row: OpenRow): Promise<boolean> {
  if (!row.loginAndActor) return false;
  if (!row.member && !(await standsOnShares(tx, row.recipientPersonId))) return false;
  const task = { id: row.subjectRecordId, clientId: row.clientId };
  if (!(await holdsOnTask(tx, row.recipientPersonId, task, 'read'))) return false;
  return (
    row.reason !== 'decision' || (await holdsOnTask(tx, row.recipientPersonId, task, 'decide'))
  );
}
