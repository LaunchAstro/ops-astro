// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder's chart (WF-2): a map, its typed tickets, their blocking and its
// fog, in one transaction. Each WF-2 command runs inside the envelope, which
// has checked the row's grant (at the ticket's or its map's scope), taken the
// `wayfinder.map` lock where the row names it, and locked and revision-checked
// the target. The frontier and summary read models move with them through the
// triggers in migration 0042, in the same transaction.

import { isTaskType } from '../../../core-records/src/index.ts';
import type { TenantQuery, TaskType } from '../../../core-records/src/index.ts';
import { applied, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { createTask } from './tasks-write.ts';
import { invalid, textOk, type RequestOf } from './wayfinder.ts';
import { applyRevision, parseRevision, type Revision } from './wayfinder-revision.ts';
import { PRE_ANSWER_FIXES, preAnswerList, refuseUncitable } from './wayfinder-pre-answers.ts';

export const TICKET_LIMIT = 100;

export interface NewTicket {
  readonly title: string;
  readonly type: TaskType;
}

/** A list of `{ title, type }`, 1 to the limit, or undefined when any entry is wrong. */
export function ticketList(value: unknown, allowEmpty: boolean): readonly NewTicket[] | undefined {
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
export async function fileTicket(
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

export async function linkBlocks(tx: TenantQuery, blocker: string, blocked: string): Promise<void> {
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

/** The chart's operands checked together: its tickets and body, or the names that are wrong. */
function chartOperands(
  request: RequestOf<'map.chart'>,
): { readonly tickets: readonly ChartTicket[]; readonly body: Revision } | readonly string[] {
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
  const preAnswers = preAnswerList(request.preAnswers);
  if (preAnswers === undefined) wrong.push('preAnswers');
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
  if (wrong.length > 0) return [...new Set(wrong)].toSorted();
  return {
    tickets: tickets as readonly ChartTicket[],
    body: { ...(revision as Revision), addPreAnswers: preAnswers ?? [] },
  };
}

/**
 * File the chart's tickets under the map in order, recording each ref's id in
 * `ids`, then link their blocking. A refused create is returned as it is.
 */
async function fileChartTickets(
  tx: TenantQuery,
  context: CommandContext,
  mapId: string,
  tickets: readonly ChartTicket[],
  ids: Record<string, string>,
): Promise<HandlerOutcome | undefined> {
  for (const ticket of tickets) {
    // Sequential: each ticket ranks after the one before it.
    // oxlint-disable-next-line no-await-in-loop
    const filed = await fileTicket(tx, context, mapId, ticket);
    if (typeof filed !== 'string') return filed;
    ids[ticket.ref] = filed;
  }
  for (const ticket of tickets) {
    for (const ref of ticket.blockedBy) {
      // oxlint-disable-next-line no-await-in-loop
      await linkBlocks(tx, ids[ref] as string, ids[ticket.ref] as string);
    }
  }
  return undefined;
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
  const operands = chartOperands(request);
  if (Array.isArray(operands)) {
    return invalid(operands as readonly string[], [
      'title is 1 to 4000 characters; tickets a list of { ref, title, type, blockedBy? }.',
      'Each blockedBy names refs of this chart, with no cycle; fog and outOfScope are lists of lines.',
      ...PRE_ANSWER_FIXES,
    ]);
  }
  const { tickets, body } = operands as Exclude<typeof operands, readonly string[]>;
  // Every citation is checked before the first row is written.
  const uncitable = await refuseUncitable(tx, context, body.addPreAnswers ?? []);
  if (uncitable !== undefined) return uncitable;
  const map = await createTask(tx, context, {
    command: 'task.create',
    operationId: '',
    fields: { title: request.title as string },
    taskType: 'map',
  } as RequestOf<'task.create'>);
  if ('refusal' in map) return map;
  const mapId = String(map.recordId);
  const ids: Record<string, string> = {};
  const refusal = await fileChartTickets(tx, context, mapId, tickets, ids);
  if (refusal !== undefined) return refusal;
  const hasBody =
    body.destination !== undefined ||
    body.notes !== undefined ||
    body.addFog.length + body.addOutOfScope.length + (body.addPreAnswers?.length ?? 0) > 0;
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
