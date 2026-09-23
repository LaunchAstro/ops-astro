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
// pattern `task.decide` uses for its own operands. The command checks are
// called by their handlers, so a refusal is registered and audited like any
// other; the read checks are called by the boundary, which is where a read
// body is first seen whole.

import { refuseCommand, type CommandRefusal } from './refusal.ts';

/** A JSON object that is not an array, which is what a field map has to be. */
function isFieldMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(name: string, fix: string): CommandRefusal {
  return refuseCommand('FIELD_VALUE_INVALID', [name], [fix]);
}

/** `task.create` writes the fields it is sent, so it needs a map of them. */
export function refuseCreateOperands(fields: unknown): CommandRefusal | undefined {
  if (isFieldMap(fields)) return undefined;
  return invalid('fields', 'Send fields as an object of field keys to values, such as { title }.');
}

/** `task.restore` restores one batch, which `task.trash` named. */
export function refuseRestoreOperands(batchId: unknown): CommandRefusal | undefined {
  if (typeof batchId === 'string' && batchId !== '') return undefined;
  return invalid('batchId', 'Send the batchId that task.trash answered with.');
}

/**
 * `task.purge` takes a window in whole days, and zero is a window: it is the
 * one a test uses to watch the retention classes in a single run. A negative
 * one reaches into the future, and a string was being coerced into a date.
 */
export function refusePurgeOperands(olderThanDays: unknown): CommandRefusal | undefined {
  if (Number.isSafeInteger(olderThanDays) && (olderThanDays as number) >= 0) return undefined;
  return invalid('olderThanDays', 'Send olderThanDays as a whole number of days, zero or more.');
}

/** The planner reads each preset field as an object; which keys it needs is its own question. */
const PRESET_FIELDS_FIX = 'Send fields as an array of field objects, which may be empty.';

/**
 * A read's operands, by the read's name. A read that takes none answers
 * `undefined` here and is untouched.
 */
export function refuseReadOperands(
  read: string,
  body: Readonly<Record<string, unknown>>,
): CommandRefusal | undefined {
  switch (read) {
    case 'task.read':
      if (typeof body['recordId'] === 'string') return undefined;
      return invalid('recordId', 'Send recordId as the task’s identifier or its key.');
    case 'preset.plan': {
      for (const name of ['recordTypeKey', 'presetKey'] as const) {
        if (typeof body[name] !== 'string' || body[name] === '') {
          return invalid(name, `Send ${name} as a non-empty string.`);
        }
      }
      const fields = body['fields'];
      if (!Array.isArray(fields) || !fields.every(isFieldMap)) {
        return invalid('fields', PRESET_FIELDS_FIX);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
