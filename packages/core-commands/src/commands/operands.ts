// SPDX-License-Identifier: AGPL-3.0-only
//
// The operands an operation cannot be asked without, checked before it runs.
//
// A request union in `requests.ts` or `reads/requests.ts` says `batchId:
// string`, but the body it describes arrived as JSON and nothing made it so.
// Five declarations took the type at its word, and an absent operand went on
// to a bound parameter or an `in` operator and came back a plain-text 500 --
// an outage where a decision was owed, which checklist B7 rules out
// (`tests/acceptance/surface-inventory.test.ts`, the faulted case).
//
// Each check answers `FIELD_VALUE_INVALID` 422 by name with a fix line, the
// pattern `task.decide` uses for its own operands. The one exception is
// `task.purge`: any `olderThanDays` is `COMMAND_BODY_INVALID` 400, because the
// operation takes no window at all (`refusePurgeOperands` below). A write's
// body is parsed against its surface row (`parseRequest`), an operand whose
// kind its handler answers in its own words is checked there, and a read's
// operand check is on its row in `reads/catalogue.ts`, so every refusal is
// registered and audited like any other.

import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { isUuid } from '../../../core-records/src/index.ts';
import type { CommandDeclaration, Operand, OperandKind } from '../../../core-wire/src/index.ts';
import type { CommandRequest, UncheckedRequest } from './requests.ts';

/** A JSON object that is not an array, which is what a field map has to be. */
export function isFieldMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `FIELD_VALUE_INVALID` naming one operand, with the fix for it. */
export function invalid(name: string, fix: string): CommandRefusal {
  return refuseCommand('FIELD_VALUE_INVALID', [name], [fix]);
}

/**
 * `task.reparent` takes the new parent, or `null` for the top level. An absent
 * `parentId` is not a request for the top level: taking it as one would detach
 * the task and take it off its board, an access change the caller never asked
 * for. A string that is not an identifier is the envelope's (`prepare.ts`,
 * `refuseMalformedIdentifier`), answered as one that names nothing.
 */
export function refuseReparentOperands(parentId: unknown): CommandRefusal | undefined {
  if (parentId === null || typeof parentId === 'string') return undefined;
  return invalid(
    'parentId',
    'Send the parent task’s id, or null to move the task to the top level.',
  );
}

/**
 * `task.purge` takes no window. The business's retention window is read from
 * its settings (`tasks-trash.ts`, SPEC:319 and C12-5 Q46), so a body naming
 * `olderThanDays` is asking for something the operation does not take. Any
 * value is refused, a valid one included, and by the code a body field the
 * operation has no use for already gets (`prepare.ts`, `refuseIrrelevantTarget`).
 * `null` is a value the caller sent, so it counts as present.
 */
export function refusePurgeOperands(olderThanDays: unknown): CommandRefusal | undefined {
  if (olderThanDays === undefined) return undefined;
  return refuseCommand(
    'COMMAND_BODY_INVALID',
    ['olderThanDays'],
    ['Send no olderThanDays: the purge uses the business’s retention_window_days setting.'],
  );
}

/**
 * Could this operand be an identifier at all? Every id column is a uuid, and a
 * string that is not one would reach a bound parameter and be raised on by the
 * server: a caller's typo answered as an outage (TRANSACTION-CONTRACT TC:11).
 * A malformed id names nothing, so the operation that owns the operand answers
 * it exactly as it answers a well-formed id that names nothing (root ruling 2).
 */
export function isIdentifier(value: unknown): value is string {
  return isUuid(value);
}

/**
 * The body parsed against its surface row's operands, once: the typed request,
 * or the refusal for what did not arrive in the kind the row describes. Both
 * prefixes ask it before any command code runs, and a command is handed what
 * it returns rather than the body.
 *
 * The answer and its precedence are the ones the operands' own checks gave:
 * every mistyped identifier by name (the required ones alone when any is),
 * then a target that is not a string, which names nothing (root ruling 2),
 * then the first other operand in the row's order, with the fix its own check
 * gives. The last two are `afterTarget`: a
 * foreign or missing record answers `NOT_FOUND` before them, as it did when a
 * command raised them, so another business's record and a fabricated one
 * still read the same.
 */
export function parseRequest(
  request: UncheckedRequest,
  declaration: CommandDeclaration,
):
  | { readonly request: CommandRequest }
  | { readonly refusal: CommandRefusal; readonly afterTarget: boolean } {
  const spec = declaration.operands ?? {};
  const mismatched = Object.entries(spec)
    .filter(([name, operand]) => !fits(request[name], operand))
    .map(([name]) => name);
  if (isDescribed(request, mismatched)) return { request };
  const ids = mismatched.filter((name) => name !== 'recordId' && kindOf(spec[name]) === 'id');
  const required = ids.filter((name) => spec[name] === 'id');
  const named = required.length > 0 ? required : ids;
  if (named.length > 0)
    return { refusal: mistyped(declaration, named.toSorted()), afterTarget: false };
  if (mismatched.includes('recordId')) return { refusal: refuseNotFound(), afterTarget: true };
  return { refusal: mistyped(declaration, mismatched.slice(0, 1)), afterTarget: true };
}

function mistyped(declaration: CommandDeclaration, names: readonly string[]): CommandRefusal {
  const fixes = new Set(names.map((name) => fixFor(declaration, name)));
  return refuseCommand('FIELD_VALUE_INVALID', names, [...fixes]);
}

/**
 * The fields of a request that name a record. Each one is cast to `uuid`
 * somewhere downstream — the authority check casts the scope, the rank query
 * casts an array of neighbours — and a cast raises rather than refusing. A
 * review found `recordId: 'not-a-uuid'` arriving as a fault with the chain
 * recording `failed`, where the contract promises a typed refusal.
 *
 * The list is explicit rather than derived from the field names, so a request
 * type that grows an identifier has to be added here rather than being
 * silently covered or silently missed.
 */
export const IDENTIFIER_FIELDS: readonly string[] = [
  'recordId',
  'parentId',
  'batchId',
  'afterId',
  'beforeId',
  'board',
  'boardSection',
  'gateId',
  'versionId',
  'lineageId',
  'reservationId',
  'leaseId',
];

/**
 * A body field the row does not describe is refused `COMMAND_BODY_INVALID`,
 * before any command code runs, after authority on both prefixes: a caller
 * without the right, a person or an agent, is told that first. A command
 * takes exactly the fields its own row declares, identifiers included, and
 * the three the envelope reads itself: the identity, the command the route
 * names and, on a command with a target, its revision.
 *
 * The refusal names no field. A key is the caller's own text, and echoing it
 * would carry whatever it holds into the register and back out; the fix names
 * the fields the row does take instead, which are the server's.
 */
export function refuseUndescribed(
  request: UncheckedRequest,
  declaration: CommandDeclaration,
): CommandRefusal | undefined {
  const spec = declaration.operands;
  if (spec === undefined) return undefined;
  const allowed = new Set([
    'command',
    'operationId',
    ...(declaration.targetsExistingRecord ? ['expectedRevision'] : []),
    ...Object.keys(spec),
  ]);
  if (Object.keys(request).every((field) => allowed.has(field))) return undefined;
  const takes = Object.keys(spec);
  return refuseCommand(
    'COMMAND_BODY_INVALID',
    [],
    [
      takes.length === 0
        ? `Send no fields but operationId${declaration.targetsExistingRecord ? ' and expectedRevision' : ''}: ${declaration.name} takes none.`
        : `Send only the fields ${declaration.name} takes: ${takes.join(', ')}.`,
    ],
  );
}

/** A request with no mismatched operand is the typed request its row describes. */
function isDescribed(
  _request: UncheckedRequest,
  mismatched: readonly string[],
): _request is CommandRequest {
  return mismatched.length === 0;
}

function fits(value: unknown, operand: Operand): boolean {
  const kind = kindOf(operand);
  if (kind === 'any') return true;
  if (value === undefined) return operand.includes('?');
  if (value === null) return operand.endsWith('|null');
  return KINDS[kind](value);
}

function kindOf(operand: Operand | undefined): OperandKind {
  return KIND_NAMES.find((kind) => operand?.startsWith(kind) === true) ?? 'any';
}

const KIND_NAMES: readonly OperandKind[] = ['id', 'text', 'count', 'flag', 'map', 'any'];

const KINDS: Readonly<Record<OperandKind, (value: unknown) => boolean>> = {
  id: (value) => typeof value === 'string',
  text: (value) => typeof value === 'string',
  count: (value) => typeof value === 'number' && Number.isFinite(value),
  flag: (value) => typeof value === 'boolean',
  map: isFieldMap,
  any: () => true,
};

function fixFor(declaration: CommandDeclaration, name: string): string {
  return OPERAND_FIXES[name] ?? KIND_FIXES[kindOf(declaration.operands?.[name])];
}

/** The fix lines the operands' own checks give, so the answer is the same. */
const OPERAND_FIXES: Readonly<Record<string, string>> = {
  fields: 'Send fields as an object of field keys to values, such as { title }.',
  batchId: 'Send the batchId that task.trash answered with.',
  payload: 'Send the payload as a JSON object.',
};

const KIND_FIXES: Readonly<Record<OperandKind, string>> = {
  id: 'Send each name above as the identifier string you were given.',
  text: 'Send each name above as a string.',
  count: 'Send each name above as a finite number.',
  flag: 'Send each name above as true or false.',
  map: 'Send each name above as a JSON object.',
  any: 'Send each name above as this command describes it.',
};
