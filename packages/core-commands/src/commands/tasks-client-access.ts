// SPDX-License-Identifier: AGPL-3.0-only
//
// Client access (MP-4-10, CS-4.10, R45): the task's share grants to its
// client's people.
//
// R45 decided that Client access is the existence of a share grant, drawn as
// the same tick as the Ad hoc mark, so nothing is stored beside the grants:
// the tick reads them (`outsideHolders`, `reads/tasks.ts`). The client's existing people are
// the persons outside the business's membership who stand on the task's
// client (`uuid_7`) through a live party-scoped `task:read` grant. That grant
// is the only standing an outside person has on main; the portal slice may
// model a client's people more richly, and this is where it would change.
//
// Turning it on shares the task, for reading, with each of them. It enrols
// and invites no one: a client with nobody standing on it is refused rather
// than recorded as shared with nobody, so the tick never says on while no one
// can see the task.
//
// Turning it off withdraws every live read share on the task held by someone
// outside the membership, not only the current client's people. A task whose
// client changed after it was shared would otherwise stay visible to the old
// client's people while the tick said off.
//
// Authority is `access:share`, asked by the envelope from the declaration
// (`surface.ts`) before either handler runs; an agent never holds it. The
// envelope locks the task row for update, so two turns at once on one task
// run one after the other and leave one share per person (`issueShare` reuses
// a live one).

import {
  effectiveGrants,
  issueShare,
  withdrawShares,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { outsideHolders } from '../reads/tasks.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext, TaskRow } from './context.ts';

const TASK = 'task';

const NO_CLIENT_FIXES = [
  'Set the task’s client first, then turn Client access on.',
  'Client access shares the task with the client’s existing people and invites no one.',
];
const NOBODY_FIXES = [
  'Nobody outside the business stands on this client yet.',
  'Client access shares the task with the client’s existing people and invites no one.',
];

export async function shareWithClient(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const target = targetOf(context);
  // A trashed task is not shared anew (`shareRecord` refuses it the same way).
  if (target.deleted_at !== null) return refused(refuseNotFound());
  const client = await clientOf(tx, context.spine.taskTypeId, target.id);
  if (client === null)
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['client'], NO_CLIENT_FIXES));
  const people = await clientPeople(tx, client);
  if (people.length === 0) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['client'], NOBODY_FIXES));
  }
  for (const personId of people) {
    // One transaction, one connection: sequential because they share it.
    // oxlint-disable-next-line no-await-in-loop
    await issueShare(tx, context.session.actorId, {
      collection: TASK,
      recordId: target.id,
      personId,
    });
  }
  return applied(target.id, target.revision, { sharedWith: people.length });
}

export async function revokeClientShare(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const target = targetOf(context);
  let withdrawn = 0;
  for (const personId of await outsideHolders(tx, target.id)) {
    // oxlint-disable-next-line no-await-in-loop
    withdrawn += await withdrawShares(tx, { collection: TASK, recordId: target.id, personId });
  }
  return applied(target.id, target.revision, { withdrawn });
}

function targetOf(context: CommandContext): TaskRow {
  if (context.target === undefined) throw new Error('client access: the envelope read no target');
  return context.target;
}

async function clientOf(
  tx: TenantQuery,
  taskTypeId: string,
  recordId: string,
): Promise<string | null> {
  const rows = await tx.query<{ readonly client: string | null }>(
    `select r.uuid_7 as client from public.records r
      where r.business_id = $1 and r.record_type_id = $2 and r.id = $3`,
    [tx.businessId, taskTypeId, recordId],
  );
  return rows[0]?.client ?? null;
}

/**
 * The client's existing people: outside the membership, standing on the
 * client through a party-scoped `task:read` that is live by the one
 * live-grant expression (`effectiveGrants`), so a grant cut from a revoked
 * parent counts for nothing. Candidates first, then each confirmed.
 */
async function clientPeople(tx: TenantQuery, client: string): Promise<readonly string[]> {
  const candidates = await tx.query<{ readonly person_id: string }>(
    `select distinct g.subject_id as person_id
       from public.grants g
      where g.business_id = $1 and g.subject_kind = 'person'
        and g.scope_kind = 'party' and g.scope_id = $2
        and g.collection = 'task' and g.action = 'read'
        and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
        and not exists (select 1 from public.memberships m
                         where m.business_id = g.business_id and m.person_id = g.subject_id
                           and m.active)
      order by 1`,
    [tx.businessId, client],
  );
  const people: string[] = [];
  for (const { person_id: personId } of candidates) {
    // oxlint-disable-next-line no-await-in-loop
    const live = await effectiveGrants(tx, [{ kind: 'person', id: personId }], {
      collection: TASK,
      action: 'read',
      scope: { kind: 'party', id: client },
    });
    if (live.some((grant) => grant.scope_kind === 'party')) people.push(personId);
  }
  return people;
}
