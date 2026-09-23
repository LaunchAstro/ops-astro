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
// checks are called by their handlers and the read checks by
// `reads/dispatch.ts`, so either refusal is registered and audited like any
// other.

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
    case 'task.board':
      // `null` is a real board: the list of tasks on none. An absent key is
      // not, and answering it with that list gave a body that asked nothing
      // the answer to a question it never put (I14-SEAM U1). A string is
      // looked up, and refused `NOT_FOUND` there if it names nothing here.
      if (typeof body['board'] === 'string' || body['board'] === null) return undefined;
      return invalid(
        'board',
        'Send board as a board task’s identifier, or null for tasks on no board.',
      );
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
