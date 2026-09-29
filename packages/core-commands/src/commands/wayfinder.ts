// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder commands (WF-1): the ticket type, the map's components and its
// client scope. A map is a task of type `map` and its tickets are its
// subtasks (W2, W3), so each command here targets a task the envelope has
// already authorised, locked and revision-checked; what is left is the rule
// that belongs to the type.

import { randomUUID } from 'node:crypto';
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

type RequestOf<K extends CommandRequest['command']> = Extract<CommandRequest, { command: K }>;

const BODY_LIMIT = 4000;
const TYPE_FIXES = [`A ticket type is one of: ${TASK_TYPES.join(', ')}.`];

function invalid(names: readonly string[], fixes: readonly string[]): HandlerOutcome {
  return refused(refuseCommand('FIELD_VALUE_INVALID', names, fixes));
}

function notPermitted(names: readonly string[], fixes: readonly string[]): HandlerOutcome {
  return refused(refuseCommand('TRANSITION_NOT_PERMITTED', names, fixes));
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

/**
 * `ticket type changed`. A retype between research, task and build is the
 * row's `task:write`. To or from grilling, prototype or map it is the map
 * owner's, under `task:decide` (TR-S-R4R-9): a teammate who holds decide but
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

  const guarded = OWNER_TYPES.has(from) || OWNER_TYPES.has(to);
  if (guarded) {
    if (!(await holdsDecide(tx, context, facts))) {
      return refused(
        refuseCommand(
          'SCOPE_NOT_GRANTED',
          ['task:decide'],
          ['Retyping to or from grilling, prototype or map needs task:decide.'],
        ),
      );
    }
    if (facts.mapOwner !== null && facts.mapOwner !== context.session.personId) {
      return refused(
        refuseCommand(
          'SCOPE_NOT_GRANTED',
          ['map owner'],
          ["Only the map's owner retypes to or from grilling, prototype or map."],
        ),
      );
    }
  }

  const history = Array.isArray(target.data['type_history'])
    ? (target.data['type_history'] as readonly unknown[])
    : [];
  const change: Record<string, unknown> = {
    type: to,
    type_history: [
      ...history,
      { from, to, actor: context.session.actorId, at: new Date().toISOString() },
    ],
  };
  if (to === 'map' && typeof target.data['map_owner'] !== 'string') {
    change['map_owner'] = context.session.personId;
  }
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || $3::jsonb, updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, target.id, change],
  );
  return applied(target.id, Number(rows[0]?.revision), { type: to, from });
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
  if (!(await holdsDecide(tx, context, facts))) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['task:decide'],
      ['Moving a grilling or prototype ticket off its map needs task:decide.'],
    );
  }
  if (facts.mapOwner !== context.session.personId) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['map owner'],
      ["Only the map's owner moves a grilling or prototype ticket off the map."],
    );
  }
  return undefined;
}

interface OutOfScopeItem {
  readonly text: string;
  readonly ticketId: string | null;
}

export interface Revision {
  readonly destination?: string;
  readonly notes?: string;
  readonly addFog: readonly string[];
  readonly addOutOfScope: readonly OutOfScopeItem[];
  readonly retire: readonly string[];
}

export function textOk(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= BODY_LIMIT;
}

/** The revision a body asks for, or the names of the operands that are wrong. */
/** The operands a revision is read from: `map.revise`'s, or a chart's. */
export interface RevisionOperands {
  readonly destination?: unknown;
  readonly notes?: unknown;
  readonly addFog?: unknown;
  readonly addOutOfScope?: unknown;
  readonly retire?: unknown;
}

export function parseRevision(
  request: RevisionOperands,
  allowEmpty = false,
): Revision | readonly string[] {
  const wrong: string[] = [];
  const text = (name: 'destination' | 'notes'): string | undefined => {
    const value = request[name];
    if (value === undefined) return undefined;
    if (!textOk(value)) wrong.push(name);
    return value as string;
  };
  const list = <T>(name: string, value: unknown, item: (v: unknown) => T | undefined): T[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100) {
      wrong.push(name);
      return [];
    }
    const out: T[] = [];
    for (const entry of value as readonly unknown[]) {
      const parsed = item(entry);
      if (parsed === undefined) {
        wrong.push(name);
        return [];
      }
      out.push(parsed);
    }
    return out;
  };
  const destination = text('destination');
  const notes = text('notes');
  const addFog = list('addFog', request.addFog, (v) => (textOk(v) ? v : undefined));
  const addOutOfScope = list('addOutOfScope', request.addOutOfScope, (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const { text: line, ticketId } = v as { text?: unknown; ticketId?: unknown };
    if (!textOk(line)) return undefined;
    if (ticketId !== undefined && ticketId !== null && !isUuid(ticketId)) return undefined;
    return { text: line, ticketId: typeof ticketId === 'string' ? ticketId.toLowerCase() : null };
  });
  const retire = list('retire', request.retire, (v) => (isUuid(v) ? v.toLowerCase() : undefined));
  if (wrong.length > 0) return [...new Set(wrong)].toSorted();
  const empty =
    destination === undefined &&
    notes === undefined &&
    addFog.length + addOutOfScope.length + retire.length === 0;
  if (empty && !allowEmpty) return ['destination', 'notes', 'addFog', 'addOutOfScope', 'retire'];
  return {
    ...(destination === undefined ? {} : { destination }),
    ...(notes === undefined ? {} : { notes }),
    addFog,
    addOutOfScope,
    retire,
  };
}

async function insertComponent(
  tx: TenantQuery,
  map: string,
  version: number,
  kind: string,
  body: string,
  ticketId: string | null,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into map_components
       (business_id, id, map_id, kind, body, ticket_id, position, created_version)
     values ($1, $2, $3, $4, $5, $6,
             coalesce((select max(position) + 1 from map_components
                        where business_id = $1 and map_id = $3 and kind = $4), 0), $7)`,
    [tx.businessId, id, map, kind, body.trim(), ticketId, version],
  );
  return id;
}

async function retireComponents(
  tx: TenantQuery,
  map: string,
  version: number,
  where: { readonly ids?: readonly string[]; readonly kind?: string },
): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `update map_components set retired_version = $3
      where business_id = $1 and map_id = $2 and retired_version is null
        and ($4::uuid[] is null or id = any($4::uuid[]))
        and ($5::text is null or kind = $5)
      returning id`,
    [tx.businessId, map, version, where.ids ?? null, where.kind ?? null],
  );
  return rows.map((row) => row.id);
}

/** A patch leaving the fog for the tickets it became (WF-2). */
export interface Graduation {
  readonly patchId: string;
  readonly tickets: readonly string[];
}

/**
 * Write one numbered version of a map: retire, replace and add components,
 * record which ones changed, and move the map's revision. The caller has
 * already checked every operand, and holds the map lock (`wayfinder.map`).
 */
export async function applyRevision(
  tx: TenantQuery,
  context: CommandContext,
  mapId: string,
  parsed: Revision,
  graduation?: Graduation,
): Promise<{
  readonly version: number;
  readonly changed: readonly string[];
  readonly revision: number;
}> {
  const numbered = await tx.query<{ readonly next: number }>(
    `select coalesce(max(version), 0) + 1 as next from map_versions
      where business_id = $1 and map_id = $2`,
    [tx.businessId, mapId],
  );
  const version = Number(numbered[0]?.next ?? 1);
  const changed: string[] = [];
  changed.push(...(await retireComponents(tx, mapId, version, { ids: parsed.retire })));
  if (graduation !== undefined) {
    await tx.query(
      `update map_components set retired_version = $3, graduated_into = $4::uuid[]
        where business_id = $1 and id = $2`,
      [tx.businessId, graduation.patchId, version, graduation.tickets],
    );
    changed.push(graduation.patchId);
  }
  for (const kind of ['destination', 'notes'] as const) {
    const body = parsed[kind];
    if (body === undefined) continue;
    // In order: retire the current one, then write its successor.
    // oxlint-disable-next-line no-await-in-loop
    changed.push(...(await retireComponents(tx, mapId, version, { kind })));
    // oxlint-disable-next-line no-await-in-loop
    changed.push(await insertComponent(tx, mapId, version, kind, body, null));
  }
  for (const line of parsed.addFog) {
    // oxlint-disable-next-line no-await-in-loop
    changed.push(await insertComponent(tx, mapId, version, 'fog', line, null));
  }
  for (const item of parsed.addOutOfScope) {
    const { text, ticketId } = item;
    // oxlint-disable-next-line no-await-in-loop
    changed.push(await insertComponent(tx, mapId, version, 'out_of_scope', text, ticketId));
  }
  await tx.query(
    `insert into map_versions (business_id, id, map_id, version, changed, actor_id)
     values ($1, $2, $3, $4, $5::uuid[], $6)`,
    [tx.businessId, randomUUID(), mapId, version, changed, context.session.actorId],
  );
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('map_version', $3::int), updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, mapId, version],
  );
  return { version, changed, revision: Number(rows[0]?.revision) };
}

/**
 * `map revised (version, components)`: one numbered version per revision,
 * recording every component it added or retired. A replaced Destination or
 * Notes is retired, not overwritten, so a version's body stays readable.
 */
export async function reviseMap(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'map.revise'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('reviseMap: the envelope read no target');
  if (target.data['type'] !== 'map') {
    return notPermitted(['type'], ['Only a task of type map has components to revise.']);
  }
  const revision = parseRevision(request);
  if (Array.isArray(revision)) {
    return invalid(revision as readonly string[], [
      `Destination and notes are 1 to ${String(BODY_LIMIT)} characters.`,
      'addFog is a list of lines; addOutOfScope a list of { text, ticketId? }; retire a list of component ids.',
    ]);
  }
  const parsed = revision as Revision;

  const linked = parsed.addOutOfScope.flatMap((item) =>
    item.ticketId === null ? [] : [item.ticketId],
  );
  if (linked.length > 0) {
    const children = await tx.query<{ readonly id: string }>(
      `select id from records
        where business_id = $1 and id = any($2::uuid[]) and uuid_4 = $3
          and record_type_id = $4`,
      [tx.businessId, linked, target.id, context.spine.taskTypeId],
    );
    if (children.length !== new Set(linked).size) {
      return refused(refuseCommand('NOT_FOUND', ['addOutOfScope'], ['Link a ticket of this map.']));
    }
  }
  if (parsed.retire.length > 0) {
    const current = await tx.query<{ readonly id: string }>(
      `select id from map_components
        where business_id = $1 and map_id = $2 and retired_version is null and id = any($3::uuid[])`,
      [tx.businessId, target.id, parsed.retire],
    );
    if (current.length !== new Set(parsed.retire).size) {
      return refused(
        refuseCommand('NOT_FOUND', ['retire'], ['Retire a current component of this map.']),
      );
    }
  }

  const written = await applyRevision(tx, context, target.id, parsed);
  return applied(target.id, written.revision, {
    version: written.version,
    changed: written.changed,
  });
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
