// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder's working commands (WF-2): chart, block, claim, graduate, resolve
// and close out of scope. Each runs inside the envelope, which has checked the
// row's grant (at the ticket's or its map's scope), taken the `wayfinder.map`
// lock where the row names it, and locked and revision-checked the target.
// The frontier and summary read models move with them through the triggers in
// migration 0032, in the same transaction.

import {
  isTaskType,
  isUuid,
  OWNER_TYPES,
  wayfinderFacts,
} from '../../../core-records/src/index.ts';
import type { TenantQuery, TaskType } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { createTask } from './tasks-write.ts';
import { setState } from './tasks-state.ts';
import { applyRevision, holdsDecide, parseRevision, textOk, type Revision } from './wayfinder.ts';

type RequestOf<K extends CommandRequest['command']> = Extract<CommandRequest, { command: K }>;

const TICKET_LIMIT = 100;
const GIST_LIMIT = 200;
const ANSWER_LIMIT = 20_000;

function invalid(names: readonly string[], fixes: readonly string[]): HandlerOutcome {
  return refused(refuseCommand('FIELD_VALUE_INVALID', names, fixes));
}

function notPermitted(names: readonly string[], fixes: readonly string[]): HandlerOutcome {
  return refused(refuseCommand('TRANSITION_NOT_PERMITTED', names, fixes));
}

interface NewTicket {
  readonly title: string;
  readonly type: TaskType;
}

/** A list of `{ title, type }`, 1 to the limit, or undefined when any entry is wrong. */
function ticketList(value: unknown, allowEmpty: boolean): readonly NewTicket[] | undefined {
  if (!Array.isArray(value) || value.length > TICKET_LIMIT) return undefined;
  if (value.length === 0 && !allowEmpty) return undefined;
  const out: NewTicket[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { title, type } = entry as { title?: unknown; type?: unknown };
    if (!textOk(title) || !isTaskType(type) || type === 'map') return undefined;
    out.push({ title, type });
  }
  return out;
}

/** File one ticket under a map through the ordinary create, so placement and keys are the create's. */
async function fileTicket(
  tx: TenantQuery,
  context: CommandContext,
  mapId: string,
  ticket: NewTicket,
): Promise<string | HandlerOutcome> {
  const made = await createTask(tx, context, {
    command: 'task.create',
    operationId: '',
    fields: { title: ticket.title },
    taskType: ticket.type,
    parentId: mapId,
  } as RequestOf<'task.create'>);
  if ('refusal' in made) return made;
  return String(made.recordId);
}

async function linkBlocks(tx: TenantQuery, blocker: string, blocked: string): Promise<void> {
  await tx.query(
    `insert into record_links (business_id, id, link_type, from_record_id, to_record_id)
     values ($1, gen_random_uuid(), 'blocks', $2, $3)`,
    [tx.businessId, blocker, blocked],
  );
}

interface ChartTicket extends NewTicket {
  readonly ref: string;
  readonly blockedBy: readonly string[];
}

/** The chart's tickets, refs unique, every blocker a ref of this chart, and no cycle. */
function chartTickets(value: unknown): readonly ChartTicket[] | undefined {
  if (value === undefined) return [];
  const base = ticketList(value, true);
  if (base === undefined) return undefined;
  const raw = value as readonly { ref?: unknown; blockedBy?: unknown }[];
  const refs = raw.map((entry) => entry.ref);
  if (refs.some((ref) => typeof ref !== 'string' || ref === '')) return undefined;
  if (new Set(refs).size !== refs.length) return undefined;
  const tickets: ChartTicket[] = [];
  for (const [index, entry] of raw.entries()) {
    const blockedBy = entry.blockedBy ?? [];
    if (!Array.isArray(blockedBy)) return undefined;
    if (blockedBy.some((ref) => !refs.includes(ref) || ref === entry.ref)) return undefined;
    tickets.push({ ...(base[index] as NewTicket), ref: entry.ref as string, blockedBy });
  }
  // Kahn's order: every ticket placed means no cycle.
  const placed = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const ticket of tickets) {
      if (!placed.has(ticket.ref) && ticket.blockedBy.every((ref) => placed.has(ref))) {
        placed.add(ticket.ref);
        progress = true;
      }
    }
  }
  return placed.size === tickets.length ? tickets : undefined;
}

/**
 * `map created`, `ticket created (type)`, `ticket blocking set`, in one
 * transaction: the map with its Destination and Notes, the tickets it can
 * state with their types and blocking, and the fog as patches. It resolves
 * nothing. Every operand is checked before the first row is written.
 */
export async function chartMap(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'map.chart'>,
): Promise<HandlerOutcome> {
  const wrong: string[] = [];
  if (!textOk(request.title)) wrong.push('title');
  const tickets = chartTickets(request.tickets);
  if (tickets === undefined) wrong.push('tickets');
  const outOfScope =
    request.outOfScope === undefined
      ? undefined
      : Array.isArray(request.outOfScope)
        ? (request.outOfScope as readonly unknown[]).map((text) => ({ text }))
        : null;
  if (outOfScope === null) wrong.push('outOfScope');
  const revision = parseRevision(
    {
      destination: request.destination,
      notes: request.notes,
      addFog: request.fog,
      addOutOfScope: outOfScope ?? undefined,
    },
    true,
  );
  if (Array.isArray(revision)) {
    const renamed: Record<string, string> = { addFog: 'fog', addOutOfScope: 'outOfScope' };
    wrong.push(...(revision as readonly string[]).map((name) => renamed[name] ?? name));
  }
  if (wrong.length > 0) {
    return invalid([...new Set(wrong)].toSorted(), [
      'title is 1 to 4000 characters; tickets a list of { ref, title, type, blockedBy? }.',
      'Each blockedBy names refs of this chart, with no cycle; fog and outOfScope are lists of lines.',
    ]);
  }

  const map = await createTask(tx, context, {
    command: 'task.create',
    operationId: '',
    fields: { title: request.title as string },
    taskType: 'map',
  } as RequestOf<'task.create'>);
  if ('refusal' in map) return map;
  const mapId = String(map.recordId);
  const ids: Record<string, string> = {};
  for (const ticket of tickets as readonly ChartTicket[]) {
    // Sequential: each ticket ranks after the one before it.
    // oxlint-disable-next-line no-await-in-loop
    const filed = await fileTicket(tx, context, mapId, ticket);
    if (typeof filed !== 'string') return filed;
    ids[ticket.ref] = filed;
  }
  for (const ticket of tickets as readonly ChartTicket[]) {
    for (const ref of ticket.blockedBy) {
      // oxlint-disable-next-line no-await-in-loop
      await linkBlocks(tx, ids[ref] as string, ids[ticket.ref] as string);
    }
  }
  const body = revision as Revision;
  const hasBody =
    body.destination !== undefined ||
    body.notes !== undefined ||
    body.addFog.length + body.addOutOfScope.length > 0;
  const written = hasBody ? await applyRevision(tx, context, mapId, body) : undefined;
  const current = await tx.query<{ readonly revision: string }>(
    `select revision::text as revision from records where business_id = $1 and id = $2`,
    [tx.businessId, mapId],
  );
  return applied(mapId, Number(current[0]?.revision), {
    tickets: ids,
    version: written?.version ?? 0,
  });
}

/**
 * `ticket blocking set`: the target's blockers, replaced as a set. Every
 * blocker is a live ticket of the same map (or, off a map, a live task), and
 * a set that would close a cycle is refused. The `wayfinder.map` lock makes
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
  if (!Array.isArray(blockedBy) || blockedBy.length > TICKET_LIMIT || !blockedBy.every(isUuid)) {
    return invalid(['blockedBy'], ['blockedBy is a list of ticket ids, empty to clear it.']);
  }
  const blockers = [...new Set((blockedBy as readonly string[]).map((id) => id.toLowerCase()))];
  if (blockers.includes(target.id)) {
    return notPermitted(['blockedBy'], ['A ticket cannot block itself.']);
  }
  const parent = typeof target.data['parent'] === 'string' ? target.data['parent'] : null;
  if (blockers.length > 0) {
    const found = await tx.query<{ readonly id: string }>(
      `select id from records
        where business_id = $1 and id = any($2::uuid[]) and record_type_id = $3
          and deleted_at is null and uuid_4 is not distinct from $4::uuid`,
      [tx.businessId, blockers, context.spine.taskTypeId, parent],
    );
    if (found.length !== blockers.length) {
      return refused(
        refuseCommand('NOT_FOUND', ['blockedBy'], ['Block by live tickets of the same map.']),
      );
    }
    const downstream = await tx.query<{ readonly id: string }>(
      `with recursive down(id) as (
         select to_record_id from record_links
          where business_id = $1 and link_type = 'blocks' and from_record_id = $2
         union
         select l.to_record_id from record_links l join down d on l.from_record_id = d.id
          where l.business_id = $1 and l.link_type = 'blocks')
       select id from down where id = any($3::uuid[])`,
      [tx.businessId, target.id, blockers],
    );
    if (downstream.length > 0) {
      return notPermitted(['blockedBy'], ['That blocker waits on this ticket already: a cycle.']);
    }
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
    [tx.businessId, target.id, JSON.stringify(blockers)],
  );
  return applied(target.id, Number(rows[0]?.revision), { blockedBy: blockers });
}

function completed(context: CommandContext, stateId: unknown): boolean {
  return (
    context.spine.states.find((state) => state.id === stateId)?.machineCategory === 'completed'
  );
}

/**
 * `ticket claimed`: first come. The claimer becomes the assignee of an open,
 * unclaimed ticket; anything already claimed is refused and left as it is.
 */
export async function claimTicket(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('claimTicket: the envelope read no target');
  if (completed(context, target.data['state'])) {
    return notPermitted(['state'], ['A closed ticket is not claimed.']);
  }
  if (target.data['assignee'] !== undefined && target.data['assignee'] !== null) {
    return notPermitted(['claimed'], ['Someone has claimed this ticket already.']);
  }
  if (target.data['delegate'] !== undefined && target.data['delegate'] !== null) {
    return notPermitted(['claimed'], ['An agent has claimed this ticket already.']);
  }
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('assignee', $3::uuid), updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
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

/**
 * `ticket resolved (answer, gist)`: the ticket completes and carries its
 * answer and one-line gist, which Decisions so far renders. Research, task and
 * build are the row's `task:write`; grilling and prototype are the map
 * owner's, under `task:decide`.
 */
export async function resolveTicket(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.resolve'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('resolveTicket: the envelope read no target');
  const facts = await wayfinderFacts(tx, target.id);
  if (facts === undefined) throw new Error('resolveTicket: the locked target is not a task');
  if (facts.type === 'map')
    return notPermitted(['type'], ['A map is not resolved; its tickets are.']);
  if (completed(context, target.data['state'])) {
    return notPermitted(['state'], ['This ticket is resolved already.']);
  }
  const answer = request.answer;
  const gist = request.gist;
  const wrong = [
    ...(typeof answer === 'string' && answer.trim() !== '' && answer.length <= ANSWER_LIMIT
      ? []
      : ['answer']),
    ...(typeof gist === 'string' &&
    gist.trim() !== '' &&
    gist.length <= GIST_LIMIT &&
    !/[\r\n]/u.test(gist)
      ? []
      : ['gist']),
  ];
  if (wrong.length > 0) {
    return invalid(wrong, [
      `The answer, and a one-line gist of up to ${String(GIST_LIMIT)} characters.`,
    ]);
  }
  if (OWNER_TYPES.has(facts.type)) {
    if (!(await holdsDecide(tx, context, facts))) {
      return refused(
        refuseCommand(
          'SCOPE_NOT_GRANTED',
          ['task:decide'],
          ['Resolving a grilling or prototype ticket needs task:decide.'],
        ),
      );
    }
    if (facts.mapOwner !== null && facts.mapOwner !== context.session.personId) {
      return refused(
        refuseCommand(
          'SCOPE_NOT_GRANTED',
          ['map owner'],
          ["Only the map's owner resolves a grilling or prototype ticket."],
        ),
      );
    }
  }
  const moved = await setState(tx, context, 'completed');
  if ('refusal' in moved) return moved;
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('answer', $3::text, 'gist', $4::text),
            updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, target.id, (answer as string).trim(), (gist as string).trim()],
  );
  return applied(target.id, Number(rows[0]?.revision), { gist: (gist as string).trim() });
}

/**
 * `ticket closed (out of scope)`: the ticket completes as out of scope, and
 * its map gains one Out of scope item linking it, in a new version.
 */
export async function closeOutOfScope(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.close_out_of_scope'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('closeOutOfScope: the envelope read no target');
  const facts = await wayfinderFacts(tx, target.id);
  if (facts?.mapId === null || facts?.mapId === undefined || facts.mapId === target.id) {
    return notPermitted(['parent'], ['Only a ticket of a map is closed as out of scope.']);
  }
  const reason = request.reason;
  if (reason !== undefined && !textOk(reason)) {
    return invalid(['reason'], ['The reason is 1 to 4000 characters, or leave it out.']);
  }
  const moved = await setState(tx, context, 'completed');
  if ('refusal' in moved) return moved;
  const title = typeof target.data['title'] === 'string' ? target.data['title'] : 'a ticket';
  const line = typeof reason === 'string' ? `${title}: ${reason.trim()}` : title;
  await applyRevision(tx, context, facts.mapId, {
    addFog: [],
    addOutOfScope: [{ text: line.slice(0, 4000), ticketId: target.id }],
    retire: [],
  });
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('closed_as', 'out_of_scope'), updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, target.id],
  );
  return applied(target.id, Number(rows[0]?.revision), { closedAs: 'out_of_scope' });
}
