// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.create` and `task.update`: the two commands that take field values.
//
// Both refuse before they write, which is what lets the envelope's savepoint
// be insurance rather than the mechanism. And both refuse through the records
// engine rather than through a list of their own: `refuseGenericWrite` reads
// the field definitions, so the app, the API, the command line and any future
// generic editor inherit the same answer and no surface can be more permissive
// than another (minimum contract 5.1).
//
// The one rule this file adds to the engine's is the provenance one. `source`
// in a payload is refused `SOURCE_SPOOFED` rather than the engine's
// `FIELD_NOT_WRITABLE`, because claiming provenance is a different mistake from
// writing a derived field: a body that says it was created by a person is
// claiming an authority that did not happen (minimum contract 6.1).
//
// `intake_state` is the precedence case (the root's D03 ruling). On
// `task.create` it is `SOURCE_SPOOFED` too: minimum contract line 324 names it
// for that command. On `task.update` any value, `accepted` included, goes to
// the engine and is `TRANSITION_PROTECTED` naming `task.triage`: SPEC T1-N3
// (task-demo spec line 155) and ledger D03 (line 75) require exactly that for a
// generic edit, and minimum contract lines 325 and 398 agree. That
// takes precedence over section 6.1 line 437, which answered `SOURCE_SPOOFED`
// to a body carrying `intake_state: accepted` without naming an operation. A
// generic editor cannot confer approval either way; the difference is that the
// caller is told which operation can. Either answer writes nothing, and the
// attempted value goes to the audit event and never to the response.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { readFieldDefinitions } from '../records/field-store.ts';
import { refuseGenericWrite } from '../records/fields.ts';
import { isRecordsRefusal } from '../records/refusals.ts';
import {
  DERIVED_ON_CREATE,
  deriveSource,
  mergeFieldValues,
  nextTaskKey,
  planTaskPlacement,
} from '../tasks/placement.ts';
import { fromRecords, refuseCommand, type CommandRefusal } from './refusal.ts';
import { refuseWrongValueType } from './values.ts';
import { refuseCreateOperands, refuseUpdateOperands } from './operands.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import type { TaskStateRow } from '../tasks/state.ts';
import type { CommandRequest, FieldValues } from './requests.ts';

/** The fields a create body can use to claim a provenance it does not have. */
const SPOOFABLE_ON_CREATE: readonly string[] = ['source', 'intake_state'];

/** On update `intake_state` is the operation-owned field it is; see the top. */
const SPOOFABLE_ON_UPDATE: readonly string[] = ['source'];

/**
 * A create places a task through its operands, never through `fields`.
 * `board` and `board_section` are generic on `task.update`, so the engine
 * lets them through; read from `fields` on a create they would bypass
 * `planTaskPlacement`: a subtask would keep a section the constraint then
 * rejects as a fault, or a board its parent is not on, and a top-level task
 * would be ranked against another board's siblings.
 */
const PLACED_BY_OPERAND: readonly string[] = ['board', 'board_section'];

function refuseSpoof(
  fields: FieldValues,
  spoofable: readonly string[],
): HandlerOutcome | undefined {
  const claimed = spoofable.filter((key) => key in fields).toSorted();
  if (claimed.length === 0) return undefined;
  const attempted = Object.fromEntries(claimed.map((key) => [key, fields[key]]));
  return refused(
    refuseCommand('SOURCE_SPOOFED', claimed, [
      '`source` is derived by the server from the authenticated actor and the entry point.',
      ...(claimed.includes('intake_state')
        ? ['`intake_state` is conferred by a decision, never by the body that asks for it.']
        : []),
      'The attempted value goes to the audit, not to the response.',
    ]),
    attempted,
  );
}

/**
 * Where a task starts when the caller names no state.
 *
 * `state` is a protected field: no create body may set it, and the only way in
 * is `stateKey`, which the application does not send because a person creating
 * a task is not choosing a status. Leaving it unset wrote a task with no state
 * at all -- a record the board cannot group and the detail page cannot draw,
 * and one the read contract says cannot exist, because `TaskSummary.state` is
 * not optional.
 *
 * So the server places it, by the same rule `task.reopen` already uses: the
 * first installed state in the `unstarted` category. An installation that
 * seeds none leaves the task stateless rather than inventing a row, and the
 * reads draw that honestly.
 */
function initialStateId(states: readonly TaskStateRow[]): string | undefined {
  return states.find((state) => state.machineCategory === 'unstarted')?.id;
}

/**
 * A new task.
 *
 * Placement is the server's: for a subtask the board is inherited, the section
 * is forced empty and the rank is after the last sibling, and none of the
 * three is read from the request (specification 14.2). `key` and `source` are
 * the server's too, which is why a payload carrying either is refused above
 * rather than overwritten.
 */
export async function createTask(
  tx: TenantQuery,
  context: CommandContext,
  request: Extract<CommandRequest, { command: 'task.create' }>,
): Promise<HandlerOutcome> {
  // First, because every check below reads `fields` as a map.
  const operands = refuseCreateOperands(request.fields);
  if (operands !== undefined) return refused(operands);
  const spoofed = refuseSpoof(request.fields, SPOOFABLE_ON_CREATE);
  if (spoofed !== undefined) return spoofed;

  const definitions = await readFieldDefinitions(tx, context.spine.taskTypeId);
  const classified = refuseGenericWrite(definitions, Object.keys(request.fields));
  if (classified !== undefined) {
    return refused(fromRecords(classified), attemptedFrom(request.fields, classified.names));
  }

  const mistyped = refuseWrongValueType(definitions, request.fields);
  if (mistyped !== undefined) return refused(mistyped);

  const placedInFields = PLACED_BY_OPERAND.filter((key) => key in request.fields);
  if (placedInFields.length > 0) {
    return refused(
      refuseCommand('PLACEMENT_IS_DERIVED', placedInFields, [
        'Send board and boardSection as operands beside fields, not inside them.',
        'A subtask takes its parent’s board and no section.',
      ]),
    );
  }

  // A uuid names one task in either case. Lower-cased once, so the stored
  // `parent` and `board` and the sibling lock agree with the uuid-typed slots
  // (R2-RUNTIME-58, R3-SURFACE-22).
  const parentId =
    typeof request.parentId === 'string'
      ? request.parentId.toLowerCase()
      : (request.parentId ?? null);
  const placement = await planTaskPlacement(tx, context.spine.taskTypeId, {
    parentId,
    board:
      typeof request.board === 'string' ? request.board.toLowerCase() : (request.board ?? null),
    boardSection: request.boardSection ?? null,
    suppliedKeys: Object.keys(request.fields),
  });
  if (isRecordsRefusal(placement)) return refused(fromRecords(placement));

  const named =
    request.stateKey === undefined
      ? undefined
      : context.spine.states.find((state) => state.key === request.stateKey);
  if (request.stateKey !== undefined && named === undefined) {
    return refused(
      refuseCommand(
        'NOT_FOUND',
        ['state'],
        [`The states installed here are: ${context.spine.states.map((s) => s.key).join(', ')}.`],
      ),
    );
  }
  // A completed state is reached only by `task.complete`, which writes the
  // stamp in the same act and leaves the completion event in the history
  // (specification 14.1 points 2 and 5; DATA.md: `state` is written by
  // `task.start`, `task.complete` and `task.reopen`). A create that named one
  // would be a third writer: a completed task with no stamp and no event.
  if (named?.machineCategory === 'completed') {
    return refused(
      refuseCommand(
        'TRANSITION_PROTECTED',
        ['state=task.complete'],
        ['Create the task, then call task.complete, which stamps and records the completion.'],
      ),
    );
  }
  const stateId = named?.id ?? initialStateId(context.spine.states);

  const id = randomUUID();
  const data: Record<string, unknown> = {
    ...request.fields,
    key: await nextTaskKey(tx, context.spine.taskTypeId),
    source: deriveSource('person', context.entryPoint),
    board_rank: placement.boardRank,
    ...(stateId === undefined ? {} : { state: stateId }),
    // From the placement alone: `fields` cannot carry either (refused above).
    ...(placement.board === null ? {} : { board: placement.board }),
    ...(placement.boardSection === null ? {} : { board_section: placement.boardSection }),
    ...(parentId === null ? {} : { parent: parentId }),
  };

  const rows = await tx.query<{ readonly revision: string; readonly key: string }>(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)
     returning revision::text as revision, data ->> 'key' as key`,
    [tx.businessId, id, context.spine.taskTypeId, data],
  );
  const written = rows[0];
  if (written === undefined) throw new Error('createTask: the insert returned no row');
  return applied(id, Number(written.revision), { key: written.key, source: data['source'] });
}

/**
 * A change to the fields a person may edit directly.
 *
 * The classification refusal runs first and comes from the field definitions,
 * so `state`, `assignee`, `delegate`, `parent`, `intake_state`, `stage`,
 * `client_visible` and the party link are refused here with the operation that
 * owns each of them named (T1-N3). `board` and `board_section` are the two
 * conditional ones: generic within a board the caller may already write, and
 * `task.move` when the write crosses to another board (specification 14.2
 * point 5), which is the clause T1e left this part to honour.
 */
export async function updateTask(
  tx: TenantQuery,
  context: CommandContext,
  request: Extract<CommandRequest, { command: 'task.update' }>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('updateTask: the envelope read no target');

  // First, because every check below reads `fields` as a map.
  const operands = refuseUpdateOperands(request.fields);
  if (operands !== undefined) return refused(operands);
  const spoofed = refuseSpoof(request.fields, SPOOFABLE_ON_UPDATE);
  if (spoofed !== undefined) return spoofed;

  const definitions = await readFieldDefinitions(tx, context.spine.taskTypeId);
  const classified = refuseGenericWrite(definitions, Object.keys(request.fields));
  if (classified !== undefined) {
    return refused(fromRecords(classified), attemptedFrom(request.fields, classified.names));
  }

  const mistyped = refuseWrongValueType(definitions, request.fields);
  if (mistyped !== undefined) return refused(mistyped);

  const placed = refusePlacement(request.fields, target.data);
  if (placed !== undefined) return refused(placed);

  const escalated = escalations(definitions, request.fields, target.data);
  if (escalated.length > 0) {
    return refused(
      refuseCommand('TRANSITION_PROTECTED', escalated, [
        'Moving a task to another board is an access change, not an edit.',
        'Call the operation named beside the field.',
      ]),
    );
  }

  const merged = mergeFieldValues(target.data, request.fields);
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = $3 where business_id = $1 and id = $2 and deleted_at is null
     returning revision::text as revision`,
    [tx.businessId, target.id, merged],
  );
  const written = rows[0];
  if (written === undefined) {
    return refused(refuseCommand('NOT_FOUND', [], ['No live task carries that identifier here.']));
  }
  return applied(target.id, Number(written.revision), {
    changed: Object.keys(request.fields).toSorted(),
  });
}

/**
 * The conditional half of a field's classification, read from the data rather
 * than from a list.
 *
 * A field carrying an `escalating_operation` is generic while the write stays
 * inside the container the caller already reaches, and owned when it does not.
 * For the board that means: changing `board` to a different value escalates,
 * and moving between sections of the same board does not.
 */
function escalations(
  definitions: readonly { readonly key: string; readonly escalatingOperation: string | null }[],
  fields: FieldValues,
  existing: Readonly<Record<string, unknown>>,
): readonly string[] {
  const escalating = definitions.filter((field) => field.escalatingOperation !== null);
  return escalating
    .filter((field) => field.key === 'board' && field.key in fields)
    .filter((field) => (fields[field.key] ?? null) !== (existing[field.key] ?? null))
    .map((field) => `${field.key}=${field.escalatingOperation ?? ''}`);
}

/**
 * The two placement answers an edit cannot give, refused by name before the
 * database would be asked.
 *
 * `board_rank` is generic by classification and still not a number a caller
 * sends: a rank is placed between neighbours by `task.rank` (API.md, "A rank is
 * always placed between neighbours and never sent as a number"), because two
 * clients each writing rank 5 would collide. And a subtask sits under its
 * parent rather than in a section, so a section on one is refused here, as
 * `task.create` and `task.move` refuse it, rather than reaching
 * `records_subtask_has_no_board_section` and coming back a fault.
 */
function refusePlacement(
  fields: FieldValues,
  existing: Readonly<Record<string, unknown>>,
): CommandRefusal | undefined {
  const derived = DERIVED_ON_CREATE.filter((key) => key in fields);
  if (derived.length > 0) {
    return refuseCommand('PLACEMENT_IS_DERIVED', derived, [
      'A rank is the server’s. Call task.rank with the neighbours to move a task.',
    ]);
  }
  if ((existing['parent'] ?? null) !== null && (fields['board_section'] ?? null) !== null) {
    return refuseCommand(
      'PLACEMENT_IS_DERIVED',
      ['board_section'],
      ['A subtask sits under its parent, not in a board section.'],
    );
  }
  return undefined;
}

/** Only the offending keys, and only for the audit. */
function attemptedFrom(
  fields: FieldValues,
  names: readonly string[],
): Readonly<Record<string, unknown>> {
  const keys = names.map((name) => name.split('=')[0] ?? name).filter((key) => key in fields);
  return Object.fromEntries(keys.map((key) => [key, fields[key]]));
}
