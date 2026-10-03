// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder commands (WF-1): the ticket type, its owner rule and the map's
// client scope. A map is a task of type `map` and its tickets are its
// subtasks (W2, W3), so each command here targets a task the envelope has
// already authorised, locked and revision-checked; what is left is the rule
// that belongs to the type. The map's revisions are `wayfinder-revision.ts`;
// WF-2's working commands are `wayfinder-chart.ts`, `wayfinder-blocking.ts`
// and `wayfinder-resolve.ts`.

import {
  checkAuthority,
  isTaskType,
  isUuid,
  OWNER_TYPES,
  subjectsOf,
  TASK_TYPES,
  wayfinderFacts,
} from '../../../core-records/src/index.ts';
import type { TenantQuery, TaskType, WayfinderFacts } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { raiseFrontierDecisions } from './wayfinder-frontier-raise.ts';
import { outsideHolders } from '../reads/tasks.ts';
import type { CommandRequest } from './requests.ts';
import { setPartyWhileEmpty } from './task-client-lock.ts';

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
 * under, so a client-scoped map's tickets carry the client too.
 */
export async function wayfinderDataOnCreate(
  tx: TenantQuery,
  context: CommandContext,
  type: TaskType,
  parentId: string | null,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = { type };
  if (type === 'map') data['map_owner'] = context.session.personId;
  if (parentId !== null) {
    const parent = await wayfinderFacts(tx, parentId);
    if (parent?.type === 'map' && parent.client !== null) data['client'] = parent.client;
  }
  return data;
}

export async function holdsDecide(
  tx: TenantQuery,
  context: CommandContext,
  facts: WayfinderFacts,
): Promise<boolean> {
  const subjects = subjectsOf(context.session);
  const target = context.target?.id ?? '';
  for (const id of [target, facts.mapId].filter((x): x is string => x !== null)) {
    // At most two: the ticket, then its map.
    // oxlint-disable-next-line no-await-in-loop
    const held = await checkAuthority(tx, subjects, {
      collection: context.declaration.collection,
      action: 'decide',
      scope: { kind: 'record', id },
    });
    if (held.ok) return true;
  }
  return false;
}

/** What the owner rule says when it refuses: the decide line, then the owner line. */
export interface OwnerRuleFixes {
  readonly decide: string;
  readonly owner: string;
}

/**
 * The owner rule on a grilling, prototype or map ticket: `task:decide` at the
 * ticket or its map, and the map's owner. A map with no owner recorded passes
 * the owner half unless `ownerless` says to refuse it.
 */
export async function refuseUnlessOwner(
  tx: TenantQuery,
  context: CommandContext,
  facts: WayfinderFacts,
  fixes: OwnerRuleFixes,
  ownerless: 'pass' | 'refuse' = 'pass',
): Promise<CommandRefusal | undefined> {
  if (!(await holdsDecide(tx, context, facts))) {
    return refuseCommand('SCOPE_NOT_GRANTED', ['task:decide'], [fixes.decide]);
  }
  const owner = facts.mapOwner;
  if (owner === null && ownerless === 'pass') return undefined;
  if (owner !== context.session.personId) {
    return refuseCommand('SCOPE_NOT_GRANTED', ['map owner'], [fixes.owner]);
  }
  return undefined;
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
  if (to === 'map' || facts.mapId !== null) {
    const shared = await refuseSharedIntoMap(tx, target.id);
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
