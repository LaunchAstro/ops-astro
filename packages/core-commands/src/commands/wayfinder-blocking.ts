// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder's working commands on a ticket's place on the map (WF-2): its
// blocking set, its claim, and fog graduating into tickets. Each runs inside
// the envelope (see `wayfinder-chart.ts`).

import {
  checkAuthority,
  isUuid,
  subjectsOf,
  wayfinderFacts,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { invalid, notPermitted, type RequestOf } from './wayfinder.ts';
import { applyRevision, type Revision } from './wayfinder-revision.ts';
import { fileTicket, linkBlocks, TICKET_LIMIT, ticketList } from './wayfinder-chart.ts';
import { completed } from './wayfinder-resolve.ts';

/** A blocker the caller may not name: the answer an absent id gets. */
const NO_BLOCKER = refuseCommand(
  'NOT_FOUND',
  ['blockedBy'],
  ['Block by live tickets of the same map.'],
);

/**
 * `task:read` on a blocker, at its own scope or, refused there, at its map's,
 * as the envelope asks the target's grant.
 */
async function readable(tx: TenantQuery, context: CommandContext, id: string): Promise<boolean> {
  const map = (await wayfinderFacts(tx, id))?.mapId;
  for (const scope of typeof map === 'string' ? [id, map] : [id]) {
    // At most two: the blocker, then its map.
    // oxlint-disable-next-line no-await-in-loop
    const held = await checkAuthority(tx, subjectsOf(context.session), {
      collection: context.declaration.collection,
      action: 'read',
      scope: { kind: 'record', id: scope },
    });
    if (held.ok) return true;
  }
  return false;
}

/**
 * Every blocker is a live ticket of the target's map (or, off a map, a live
 * task under the same parent), under the target's own client, never a map,
 * readable by the caller, and none already waits on the target, which would
 * close a cycle. Any other is not found, the same answer as one that does not
 * exist. The blockers are held `for share`, so none moves before the link.
 */
async function refuseBlockers(
  tx: TenantQuery,
  context: CommandContext,
  targetId: string,
  parent: string | null,
  blockers: readonly string[],
): Promise<HandlerOutcome | undefined> {
  const found = await tx.query<{ readonly id: string }>(
    `select id from records
      where business_id = $1 and id = any($2::uuid[]) and record_type_id = $3
        and deleted_at is null and uuid_4 is not distinct from $4::uuid
        and coalesce(data ->> 'type', 'task') <> 'map'
        and uuid_7 is not distinct from
            (select uuid_7 from records where business_id = $1 and id = $5)
      for share`,
    [tx.businessId, blockers, context.spine.taskTypeId, parent, targetId],
  );
  if (found.length !== blockers.length) return refused(NO_BLOCKER);
  for (const id of blockers) {
    // Sequential, stopping at the first: the answer is the same whichever.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await readable(tx, context, id))) return refused(NO_BLOCKER);
  }
  const downstream = await tx.query<{ readonly id: string }>(
    `with recursive down(id) as (
       select to_record_id from record_links
        where business_id = $1 and link_type = 'blocks' and from_record_id = $2
       union
       select l.to_record_id from record_links l join down d on l.from_record_id = d.id
        where l.business_id = $1 and l.link_type = 'blocks')
     select id from down where id = any($3::uuid[])`,
    [tx.businessId, targetId, blockers],
  );
  if (downstream.length > 0) {
    return notPermitted(['blockedBy'], ['That blocker waits on this ticket already: a cycle.']);
  }
  return undefined;
}

/**
 * `ticket blocking set`: the target's blockers, replaced as a set. Every
 * blocker is a live ticket of the same map (or, off a map, a live task under
 * the same parent and client), and a set that would close a cycle is refused. The `wayfinder.map` lock makes
 * the cycle check and the write one step against every other blocking set.
 */
export async function setBlocking(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.set_blocking'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('setBlocking: the envelope read no target');
  const blockedBy = request.blockedBy;
  if (
    !Array.isArray(blockedBy) ||
    blockedBy.length > TICKET_LIMIT ||
    !blockedBy.every((id) => isUuid(id))
  ) {
    return invalid(['blockedBy'], ['blockedBy is a list of ticket ids, empty to clear it.']);
  }
  const blockers = [...new Set((blockedBy as readonly string[]).map((id) => id.toLowerCase()))];
  if (blockers.includes(target.id)) {
    return notPermitted(['blockedBy'], ['A ticket cannot block itself.']);
  }
  const parent = typeof target.data['parent'] === 'string' ? target.data['parent'] : null;
  if (blockers.length > 0) {
    const refusal = await refuseBlockers(tx, context, target.id, parent, blockers);
    if (refusal !== undefined) return refusal;
  }
  await tx.query(
    `delete from record_links
      where business_id = $1 and link_type = 'blocks' and to_record_id = $2`,
    [tx.businessId, target.id],
  );
  for (const blocker of blockers) {
    // oxlint-disable-next-line no-await-in-loop
    await linkBlocks(tx, blocker, target.id);
  }
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('blocked_by', $3::jsonb), updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, target.id, blockers],
  );
  return applied(target.id, Number(rows[0]?.revision), { blockedBy: blockers });
}

/**
 * `ticket claimed`: first come. The claimer becomes the assignee of an open,
 * unclaimed ticket of a map; anything already claimed, by a person, a
 * delegate or an agent assignee, is refused and left as it is. A trashed
 * ticket is not found, as one that does not exist.
 */
export async function claimTicket(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('claimTicket: the envelope read no target');
  if (target.deleted_at !== null) return refused(refuseNotFound());
  const facts = await wayfinderFacts(tx, target.id);
  if (facts?.mapId === null || facts?.mapId === undefined || facts.mapId === target.id) {
    return notPermitted(['parent'], ['Only a ticket of a map is claimed.']);
  }
  if (completed(context, target.data['state'])) {
    return notPermitted(['state'], ['A closed ticket is not claimed.']);
  }
  if (target.data['assignee'] !== undefined && target.data['assignee'] !== null) {
    return notPermitted(['claimed'], ['Someone has claimed this ticket already.']);
  }
  for (const held of ['delegate', 'agent']) {
    if (target.data[held] !== undefined && target.data[held] !== null) {
      return notPermitted(['claimed'], ['An agent has claimed this ticket already.']);
    }
  }
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('assignee', $3::uuid), updated_at = now()
      where business_id = $1 and id = $2 and deleted_at is null
      returning revision::text as revision`,
    [tx.businessId, target.id, context.session.personId],
  );
  return applied(target.id, Number(rows[0]?.revision), { assignee: context.session.personId });
}

/**
 * `fog graduated (patch, tickets)`: the patch leaves the fog, the tickets it
 * became are filed under the map, and the version names both.
 */
export async function graduateFog(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'map.graduate'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('graduateFog: the envelope read no target');
  if (target.data['type'] !== 'map') {
    return notPermitted(['type'], ['Only a map has fog to graduate.']);
  }
  const tickets = ticketList(request.tickets, false);
  if (!isUuid(request.patchId) || tickets === undefined) {
    return invalid(
      [
        ...(isUuid(request.patchId) ? [] : ['patchId']),
        ...(tickets === undefined ? ['tickets'] : []),
      ],
      ['Name the fog patch by its id and list the tickets it becomes as { title, type }.'],
    );
  }
  const patch = await tx.query<{ readonly id: string }>(
    `select id from map_components
      where business_id = $1 and map_id = $2 and id = $3 and kind = 'fog' and retired_version is null`,
    [tx.businessId, target.id, request.patchId.toLowerCase()],
  );
  if (patch[0] === undefined) {
    return refused(
      refuseCommand('NOT_FOUND', ['patchId'], ['Name a fog patch still on this map.']),
    );
  }
  const made: string[] = [];
  for (const ticket of tickets) {
    // oxlint-disable-next-line no-await-in-loop
    const filed = await fileTicket(tx, context, target.id, ticket);
    if (typeof filed !== 'string') return filed;
    made.push(filed);
  }
  const empty: Revision = { addFog: [], addOutOfScope: [], retire: [] };
  const written = await applyRevision(tx, context, target.id, empty, {
    patchId: patch[0].id,
    tickets: made,
  });
  return applied(target.id, written.revision, { version: written.version, tickets: made });
}
