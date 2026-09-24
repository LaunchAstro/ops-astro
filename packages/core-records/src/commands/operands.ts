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
// operation takes no window at all (`refusePurgeOperands` below). The command
// checks are called by their handlers, and a read's operand check is on its
// row in `reads/catalogue.ts`, so either refusal is registered and audited
// like any other.

import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { isUuid } from '../tenancy/ids.ts';

/** A JSON object that is not an array, which is what a field map has to be. */
export function isFieldMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `FIELD_VALUE_INVALID` naming one operand, with the fix for it. */
export function invalid(name: string, fix: string): CommandRefusal {
  return refuseCommand('FIELD_VALUE_INVALID', [name], [fix]);
}

/** `task.create` writes the fields it is sent, so it needs a map of them. */
export function refuseCreateOperands(fields: unknown): CommandRefusal | undefined {
  if (isFieldMap(fields)) return undefined;
  return invalid('fields', 'Send fields as an object of field keys to values, such as { title }.');
}

/**
 * `task.update` writes the fields it is sent as `task.create` does, so it needs
 * the same map. The five owning operations (`task.assign` and the rest, in
 * `tasks-state.ts`) read `fields` the same way and want the same check.
 */
export function refuseUpdateOperands(fields: unknown): CommandRefusal | undefined {
  return refuseCreateOperands(fields);
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

/** `task.restore` restores one batch, which `task.trash` named. */
export function refuseRestoreOperands(batchId: unknown): CommandRefusal | undefined {
  if (typeof batchId === 'string' && batchId !== '') return undefined;
  return invalid('batchId', 'Send the batchId that task.trash answered with.');
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
