// SPDX-License-Identifier: AGPL-3.0-only
//
// An inbox item's access axis (INB-1a), derived on every read from the
// recipient's live grants and never stored: readable, withheld or gone.
import { effectiveGrants, type Action, type Scope, type Subject } from '../authority/grants.ts';
import { grantedScopes } from '../authority/grant-reach.ts';
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
  const subjects = await recipientSubjects(tx, personId);
  return await accessOf(tx, subjects, taskId, task.trashed, task.clientId);
}

/** The person and their own acting identities: the two a grant may name. */
export async function recipientSubjects(
  tx: TenantQuery,
  personId: string,
): Promise<readonly Subject[]> {
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
 * Read on the task through the one effective-grant walk: a business grant, a
 * grant on this task, or a party grant on the task's own client. A party grant
 * on another client reaches nothing here, which is the client separation.
 */
export async function accessOf(
  tx: TenantQuery,
  subjects: readonly Subject[],
  taskId: string,
  trashed: boolean,
  clientId: string | null,
): Promise<InboxAccess> {
  if (!(await holds(tx, subjects, taskId, clientId, 'read'))) return 'withheld';
  return trashed ? 'gone' : 'readable';
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
  return await holds(tx, await recipientSubjects(tx, personId), task.id, task.clientId, action);
}

/**
 * Where a person reads tasks now, for a query that filters inside itself
 * (INB-1e): the whole business, these tasks, or these clients' tasks. The
 * same grants `accessOf` asks, listed once instead of asked per task.
 */
export async function readScopes(
  tx: TenantQuery,
  personId: string,
): Promise<{
  readonly business: boolean;
  readonly records: readonly string[];
  readonly parties: readonly string[];
}> {
  const scopes = await grantedScopes(tx, await recipientSubjects(tx, personId), {
    collection: 'task',
    action: 'read',
  });
  const ids = (kind: Scope['kind']): string[] =>
    scopes.flatMap((scope) => (scope.kind === kind && scope.id !== null ? [scope.id] : []));
  return {
    business: scopes.some((scope) => scope.kind === 'business'),
    records: ids('record'),
    parties: ids('party'),
  };
}

async function holds(
  tx: TenantQuery,
  subjects: readonly Subject[],
  taskId: string,
  clientId: string | null,
  action: Action,
): Promise<boolean> {
  const scopes: Scope[] = [{ kind: 'record', id: taskId }];
  if (clientId !== null) scopes.push({ kind: 'party', id: clientId });
  for (const scope of scopes) {
    // oxlint-disable-next-line no-await-in-loop
    const grants = await effectiveGrants(tx, subjects, { collection: 'task', action, scope });
    if (grants.length > 0) return true;
  }
  return false;
}
