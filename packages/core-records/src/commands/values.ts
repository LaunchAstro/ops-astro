// SPDX-License-Identifier: AGPL-3.0-only
//
// Does this value fit the field it was sent for?
//
// Without this, a value of the wrong shape reaches the projection trigger,
// which casts it and raises — and a raise is not a refusal. The caller gets a
// fault where the contract promises a typed refusal with a stable code, and
// the audit records the attempt as `failed` rather than as the refusal it
// really was. "Anything that is not an explicit allow is a refusal" has to
// cover a badly typed value too.
//
// It checks the shape and not the target. A uuid that is well formed and names
// nothing is a different answer — `NOT_FOUND`, from the operation that knows
// what the link is supposed to reach — and it is not this function's to give.

import type { FieldDefinition } from '../records/fields.ts';
import { isLive } from '../records/fields.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { FieldValues } from './requests.ts';
import { isUuid } from '../tenancy/ids.ts';

const NUL = String.fromCodePoint(0);

// A date, optionally a time, optionally a zone. Anything looser is a value
// the column will refuse after this function has said it was fine.
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/u;

function fits(value: unknown, valueType: FieldDefinition['valueType']): boolean {
  switch (valueType) {
    case 'uuid':
      return isUuid(value);
    case 'text':
      // A NUL byte cannot be stored in a text column or a jsonb string, so a
      // value carrying one is refused here rather than raised on by the
      // server. It arrives from real clients: a fixed-width field padded with
      // zeros, a C string that kept its terminator.
      return typeof value === 'string' && !value.includes(NUL);
    case 'numeric':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'timestamptz':
      // `Date.parse` is far more forgiving than a timestamp column: it reads
      // '1' as the year 2001 and hands back a number, and then Postgres
      // raises. A review found exactly that. So the shape is checked first
      // and the parse second, and the shape is the one a JSON client sends.
      return typeof value === 'string' && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
    case 'json':
      return true;
  }
}

/** The fields whose values could not be what the definition says they are. */
export function refuseWrongValueType(
  definitions: readonly FieldDefinition[],
  fields: FieldValues,
): CommandRefusal | undefined {
  const live = new Map(definitions.filter((field) => isLive(field)).map((f) => [f.key, f]));
  const wrong = Object.entries(fields)
    .filter(([key, value]) => {
      const field = live.get(key);
      // An explicit null clears a field and is not a value of any type.
      return field !== undefined && value !== null && !fits(value, field.valueType);
    })
    .map(([key]) => `${key}=${live.get(key)?.valueType ?? ''}`)
    .toSorted();

  if (wrong.length === 0) return undefined;
  return refuseCommand('FIELD_VALUE_INVALID', wrong, [
    'Each name above is followed by the type the field definition gives it.',
    'A link field takes the identifier of a record, not a label a person reads.',
  ]);
}
