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
import type { CommandRequest } from './requests.ts';

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
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || $3::jsonb, updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, target.id, retypeChange(context, from, to)],
  );
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
 * A grilling or prototype ticket moving to another parent. Its owner rule
 * reads the map it is filed under, so leaving that map would leave the rule
 * behind: a move to any other parent needs `task:decide` and the owner of the
 * map it leaves, as a retype does. Anything else moves as before.
 */
export async function refuseOwnerTicketMove(
  tx: TenantQuery,
  context: CommandContext,
  recordId: string,
  parentId: string | null,
): Promise<CommandRefusal | undefined> {
  const facts = await wayfinderFacts(tx, recordId);
  if (facts === undefined || facts.type === 'map' || !OWNER_TYPES.has(facts.type)) return undefined;
  if (facts.mapId === null || facts.mapId === parentId) return undefined;
  return await refuseUnlessOwner(
    tx,
    context,
    facts,
    {
      decide: 'Moving a grilling or prototype ticket off its map needs task:decide.',
      owner: "Only the map's owner moves a grilling or prototype ticket off the map.",
    },
    'refuse',
  );
}

/**
 * `map scoped (client)`: the map and every ticket under it carry the client,
 * so a grant scoped to the client reaches them together. Null clears it.
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
  const value = client === null ? null : client.toLowerCase();
  const change = `case when $3::uuid is null then data - 'client'
                       else data || jsonb_build_object('client', $3::uuid) end`;
  await tx.query(
    `update records set data = ${change}, updated_at = now()
      where business_id = $1 and uuid_4 = $2 and record_type_id = $4`,
    [tx.businessId, target.id, value, context.spine.taskTypeId],
  );
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = ${change}, updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, target.id, value],
  );
  return applied(target.id, Number(rows[0]?.revision), { client: value });
}
