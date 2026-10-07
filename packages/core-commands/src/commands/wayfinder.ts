// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder commands (WF-1): the ticket type, its owner rule and the map's
// client scope. A map is a task of type `map` and its tickets are its
// subtasks (W2, W3), so each command here targets a task the envelope has
// already authorised, locked and revision-checked; what is left is the rule
// that belongs to the type; a map's revisions and WF-2's commands sit beside it.

import {
  checkAuthority,
  isTaskType,
  isUuid,
  OWNER_TYPES,
  subjectsOf,
  TASK_TYPES,
  wayfinderFacts,
} from '../../../core-records/src/index.ts';
import type { TenantQuery, TaskType } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { raiseFrontierDecisions } from './wayfinder-frontier-raise.ts';
import { outsideHolders } from '../reads/tasks.ts';
import type { CommandRequest } from './requests.ts';
import { setPartyWhileEmpty } from './task-client-lock.ts';
import { refuseUnlessOwner } from './wayfinder-owner.ts';

export type RequestOf<K extends CommandRequest['command']> = Extract<
  CommandRequest,
  { command: K }
>;

export const BODY_LIMIT = 4000;
const TYPE_FIXES = [`A ticket type is one of: ${TASK_TYPES.join(', ')}.`];

export function invalid(names: readonly string[], fixes: readonly string[]): HandlerOutcome {
  return refused(refuseCommand('FIELD_VALUE_INVALID', names, fixes));
}

export function notPermitted(names: readonly string[], fixes: readonly string[]): HandlerOutcome {
  return refused(refuseCommand('TRANSITION_NOT_PERMITTED', names, fixes));
}

export function textOk(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= BODY_LIMIT;
}

/** The type a create names, or the refusal; `task` when it names none. */
export function taskTypeOperand(value: unknown): TaskType | CommandRefusal {
  if (value === undefined) return 'task';
  if (isTaskType(value)) return value;
  return refuseCommand('FIELD_VALUE_INVALID', ['taskType'], TYPE_FIXES);
}

/**
 * What a new task's `data` gains from its type and its parent: the type, the
 * owner of a new map (its creator), and the client of the map it is filed
 * under, so a client-scoped map's tickets carry the client too. Filing a
 * grilling or prototype ticket applies the map's owner and decide rule.
 */
export async function wayfinderDataOnCreate(
  tx: TenantQuery,
  context: CommandContext,
  type: TaskType,
  parentId: string | null,
): Promise<Record<string, unknown> | CommandRefusal> {
  const data: Record<string, unknown> = { type };
  if (type === 'map') data['map_owner'] = context.session.personId;
  if (parentId !== null) {
    const parent = await wayfinderFacts(tx, parentId);
    if (parent?.type === 'map' && type !== 'map' && OWNER_TYPES.has(type)) {
      // A create has no ticket yet, so task:decide is checked at the map.
      const decide = await checkAuthority(tx, subjectsOf(context.session), {
        collection: context.declaration.collection,
        action: 'decide',
        scope: { kind: 'record', id: parentId },
      });
      if (!decide.ok) {
        return refuseCommand(
          'SCOPE_NOT_GRANTED',
          ['task:decide'],
          ['Filing a grilling or prototype ticket on a map needs task:decide.'],
        );
      }
      if (parent.mapOwner !== context.session.personId) {
        return refuseCommand(
          'SCOPE_NOT_GRANTED',
          ['map owner'],
          ["Only the map's owner files a grilling or prototype ticket on the map."],
        );
      }
    }
    if (parent?.type === 'map' && parent.client !== null) data['client'] = parent.client;
  }
  return data;
}

/**
 * `ticket type changed`. A retype between research, task and build is the
 * row's `task:write`. To or from grilling, prototype or map it is the map
 * owner's, under `task:decide`: a teammate who holds decide but
 * does not own the map is refused, so a retype cannot route around the rule
 * that only the owner resolves grilling and prototype tickets.
 */
export async function setTaskType(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.set_type'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('setTaskType: the envelope read no target');
  if (!isTaskType(request.taskType)) return invalid(['taskType'], TYPE_FIXES);
  const to = request.taskType;
  const facts = await wayfinderFacts(tx, target.id);
  if (facts === undefined) throw new Error('setTaskType: the locked target is not a task');
  const from = facts.type;
  if (from === to) {
    return notPermitted([`type=${from}`], ['The ticket already has this type.']);
  }
  if (OWNER_TYPES.has(from) || OWNER_TYPES.has(to)) {
    const refusal = await refuseUnlessOwner(tx, context, facts, {
      decide: 'Retyping to or from grilling, prototype or map needs task:decide.',
      owner: "Only the map's owner retypes to or from grilling, prototype or map.",
    });
    if (refusal !== undefined) return refused(refusal);
  }
  // Any typed task, or a ticket of a map, is a wayfinder record (`isWayfinderRecord`):
  // none keeps client access, and a new map's subtasks become its tickets.
  if (to !== 'task' || facts.mapId !== null) {
    const shared = await refuseSharedIntoMap(tx, target.id);
    if (shared !== undefined) return refused(shared);
  }
  if (to === 'map') {
    const shared = await refuseSharedChildren(tx, context, target.id);
    if (shared !== undefined) return refused(shared);
  }
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || $3::jsonb, updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, target.id, retypeChange(context, from, to)],
  );
  await raiseFrontierDecisions(tx, target.id);
  return applied(target.id, Number(rows[0]?.revision), { type: to, from });
}

/** The data a retype writes: the type, one more history entry, and an owner for a new map. */
function retypeChange(
  context: CommandContext,
  from: TaskType,
  to: TaskType,
): Record<string, unknown> {
  const data = context.target?.data ?? {};
  const history = Array.isArray(data['type_history'])
    ? (data['type_history'] as readonly unknown[])
    : [];
  const change: Record<string, unknown> = {
    type: to,
    type_history: [
      ...history,
      { from, to, actor: context.session.actorId, at: new Date().toISOString() },
    ],
  };
  if (to === 'map' && typeof data['map_owner'] !== 'string') {
    change['map_owner'] = context.session.personId;
  }
  return change;
}

/**
 * A task holding client access stays off maps (WF-1): a map, its tickets and
 * their threads never reach a client surface, so the share would outlive its
 * purpose. Refused, writing nothing, until client access is turned off.
 */
export async function refuseSharedIntoMap(
  tx: TenantQuery,
  recordId: string,
): Promise<CommandRefusal | undefined> {
  if ((await outsideHolders(tx, recordId)).length === 0) return undefined;
  return refuseCommand(
    'TRANSITION_NOT_PERMITTED',
    ['client access'],
    ['Turn client access off first: a map and its tickets stay internal.'],
  );
}

/** A subtask, live or trashed, holding client access; locked first, so a share in flight is seen. */
async function refuseSharedChildren(
  tx: TenantQuery,
  context: CommandContext,
  recordId: string,
): Promise<CommandRefusal | undefined> {
  const children = await tx.query<{ readonly id: string }>(
    `select id from records where business_id = $1 and record_type_id = $2 and uuid_4 = $3 for update`,
    [tx.businessId, context.spine.taskTypeId, recordId],
  );
  for (const { id } of children) {
    // oxlint-disable-next-line no-await-in-loop -- stops at the first; the answer is the same
    const shared = await refuseSharedIntoMap(tx, id);
    if (shared !== undefined) return shared;
  }
  return undefined;
}

/**
 * A task moving to another parent, held to the map rules at both ends. A
 * grilling or prototype ticket leaving its map needs `task:decide` and the
 * owner of the map it leaves, as a retype does; one arriving on a map needs
 * the same of the map it joins, so a ticket retyped while it had no map
 * cannot route around the owner rule. A task with client access joins no map.
 */
export async function refuseOwnerTicketMove(
  tx: TenantQuery,
  context: CommandContext,
  recordId: string,
  parentId: string | null,
): Promise<CommandRefusal | undefined> {
  const facts = await wayfinderFacts(tx, recordId);
  if (facts === undefined) return undefined;
  const guarded = facts.type !== 'map' && OWNER_TYPES.has(facts.type);
  if (guarded && facts.mapId !== null && facts.mapId !== parentId) {
    const leaving = await refuseUnlessOwner(
      tx,
      context,
      facts,
      {
        decide: 'Moving a grilling or prototype ticket off its map needs task:decide.',
        owner: "Only the map's owner moves a grilling or prototype ticket off the map.",
      },
      'refuse',
    );
    if (leaving !== undefined) return leaving;
  }
  // Parent held `for share` before its type is read: a retype in flight is seen.
  if (parentId !== null) await wayfinderFacts(tx, parentId, true);
  const into = parentId === null ? undefined : await wayfinderFacts(tx, parentId);
  if (into?.type !== 'map' || into.mapId === facts.mapId) return undefined;
  const shared = await refuseSharedIntoMap(tx, recordId);
  if (shared !== undefined || !guarded) return shared;
  return await refuseUnlessOwner(
    tx,
    context,
    into,
    {
      decide: 'Filing a grilling or prototype ticket on a map needs task:decide.',
      owner: "Only the map's owner files a grilling or prototype ticket on the map.",
    },
    'refuse',
  );
}

/**
 * `map scoped (client)`: a client change on a task of type `map`, held to
 * `task.set_party`'s rules on every path: asked under `share`, a client of
 * this business only, refused `CLIENT_LOCKED` once the map has content (a
 * ticket is content, S0-5), and carried down to everything under it. Null
 * clears it.
 */
export async function scopeMap(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'map.scope'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('scopeMap: the envelope read no target');
  if (target.data['type'] !== 'map') {
    return notPermitted(['type'], ['Only a task of type map is scoped to a client.']);
  }
  const client = request.client;
  if (client !== null && !isUuid(client)) {
    return invalid(['client'], ['Name the client by its identifier, or null to clear it.']);
  }
  return await setPartyWhileEmpty(tx, context, {
    client: client === null ? null : client.toLowerCase(),
  });
}
