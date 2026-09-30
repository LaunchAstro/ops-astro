// SPDX-License-Identifier: AGPL-3.0-only
//
// An inbox item's access axis (INB-1a), derived on every read from the
// recipient's live grants and never stored: readable, withheld or gone.
import {
  EFFECTIVE,
  effectiveGrants,
  type Action,
  type Scope,
  type Subject,
} from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/**
 * Derived at every read, never stored. `withheld`: the recipient holds no read
 * on the task. `gone`: the task is trashed and the recipient still holds read
 * on it; without read a trashed task is withheld, so it tells a stranger
 * nothing.
 */
export type InboxAccess = 'readable' | 'withheld' | 'gone';

/** One person's access to one task, derived as every read derives it. */
export async function taskAccess(
  tx: TenantQuery,
  personId: string,
  taskId: string,
): Promise<InboxAccess> {
  const rows = await tx.query<{ readonly trashed: boolean; readonly clientId: string | null }>(
    `select deleted_at is not null as trashed, uuid_7 as "clientId" from public.records
      where business_id = $1 and id = $2`,
    [tx.businessId, taskId],
  );
  const task = rows[0];
  if (task === undefined) return 'gone';
  // A business grant, a grant on this task, or a party grant on the task's
  // own client: a party grant on another client reaches nothing here, which
  // is the client separation.
  if (!(await holdsOnTask(tx, personId, { id: taskId, clientId: task.clientId }, 'read'))) {
    return 'withheld';
  }
  return task.trashed ? 'gone' : 'readable';
}

/** The person and their own acting identities: the two a grant may name. */
async function recipientSubjects(tx: TenantQuery, personId: string): Promise<readonly Subject[]> {
  const actors = await tx.query<{ readonly id: string }>(
    `select id from public.actors
      where business_id = $1 and person_id = $2 and kind = 'person' and active`,
    [tx.businessId, personId],
  );
  return [
    { kind: 'person', id: personId },
    ...actors.map((actor): Subject => ({ kind: 'actor', id: actor.id })),
  ];
}

/**
 * Whether a person holds `task:<action>` on a task now (INB-1e), through the
 * same walk access takes: an unattended item asks read of every recipient,
 * and decide of a decision's.
 */
export async function holdsOnTask(
  tx: TenantQuery,
  personId: string,
  task: { readonly id: string; readonly clientId: string | null },
  action: Action,
): Promise<boolean> {
  const subjects = await recipientSubjects(tx, personId);
  const scopes: Scope[] = [{ kind: 'record', id: task.id }];
  if (task.clientId !== null) scopes.push({ kind: 'party', id: task.clientId });
  for (const scope of scopes) {
    // oxlint-disable-next-line no-await-in-loop
    const grants = await effectiveGrants(tx, subjects, { collection: 'task', action, scope });
    if (grants.length > 0) return true;
  }
  return false;
}

/**
 * Where person $2 reads tasks now, for a query that filters inside itself
 * (INB-1e): `reach`, one row of the whole business, these tasks, or these
 * clients' tasks. The same grants `taskAccess` asks, walked in the statement
 * that uses them, so a grant revoked before that statement runs reaches
 * nothing in it. Opens a `with` list for the caller's own queries to follow.
 */
export const REACH: string = `${EFFECTIVE},
  reach as (
    select coalesce(bool_or(e.scope_kind = 'business'), false) as business,
           coalesce(array_agg(e.scope_id) filter (where e.scope_kind = 'record'), '{}') as records,
           coalesce(array_agg(e.scope_id) filter (where e.scope_kind = 'party'), '{}') as parties
      from effective e
     where e.collection = 'task' and e.action = 'read'
       and (e.scope_kind = 'business' or e.scope_id is not null)
       and ((e.subject_kind = 'person' and e.subject_id = $2)
            or (e.subject_kind = 'actor' and e.subject_id in (
                  select a.id from public.actors a
                   where a.business_id = $1 and a.person_id = $2 and a.kind = 'person' and a.active)))
  )`;
