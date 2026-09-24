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
// With the `u` flag a paired surrogate is one code point and does not match.
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * A string the stores can hold. Every field value lands in `records.data`, and
 * every other free-text or json operand in a text or jsonb column; a jsonb
 * string refuses U+0000 and an unpaired surrogate alike, and a text column
 * refuses U+0000. An unpaired surrogate reaching a text column is worse than a
 * raise: the driver writes U+FFFD in its place, so what is stored is not what
 * was sent or what the payload digest covers.
 *
 * The one definition of the rule (final review round 2, R2-THERMO-11). The
 * field engine applies it to field values below, `prepare.ts` to every other
 * operand at the door, and `tasks-comment.ts` to the comment body the agent
 * entry writes without passing that door.
 */
export function storableText(value: string): boolean {
  return !value.includes(NUL) && !UNPAIRED_SURROGATE.test(value);
}

/** A json value whose every string and key the stores can hold. */
export function storableJson(value: unknown): boolean {
  if (typeof value === 'string') return storableText(value);
  if (Array.isArray(value)) return value.every((member) => storableJson(member));
  if (typeof value !== 'object' || value === null) return true;
  return Object.entries(value).every(([key, member]) => storableText(key) && storableJson(member));
}

const UNSTORABLE_FIXES: readonly string[] = [
  'Each name above holds a NUL character or half of a split character, which cannot be stored.',
  'Remove the NUL, or send the whole character, and send the request again.',
];

/**
 * The names among `operands` whose value in `named` the stores cannot hold,
 * sorted. A successor is named by its inner key (`successor.payload`), as
 * `successor.ts` names its other refusals; anything else by its own name.
 */
export function unstorableOperands(
  named: Readonly<Record<string, unknown>>,
  operands: readonly string[],
): readonly string[] {
  return operands
    .flatMap((field) => {
      const value = named[field];
      if (storableJson(value)) return [];
      if (field !== 'successor' || typeof value !== 'object' || value === null) return [field];
      if (Array.isArray(value)) return [field];
      return Object.entries(value)
        .filter(([key, member]) => !storableText(key) || !storableJson(member))
        .map(([key]) => `successor.${key}`);
    })
    .toSorted();
}

/** `FIELD_VALUE_INVALID` naming the operands that could not be stored as sent. */
export function refuseUnstorable(names: readonly string[]): CommandRefusal {
  return refuseCommand('FIELD_VALUE_INVALID', names, UNSTORABLE_FIXES);
}

// A date, optionally a time, optionally a zone. Anything looser is a value
// the column will refuse after this function has said it was fine.
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:[Zz]|[+-](\d{2}):?(\d{2}))?)?$/u;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/**
 * A timestamp a `timestamptz` column takes, by the column's own limits.
 *
 * `Date.parse` was the second check, and it is more forgiving than the column:
 * it reads '1' as the year 2001, rolls 30 February over into March and takes
 * an offset of +20:00, all of which Postgres refuses. Final review round 2
 * (R2-THERMO-22) found `due: '2026-02-30'` answered as a fault. So the fields
 * are read from the shape and held to the column's ranges, measured against
 * Postgres 18: a year from 1, a real day of that month (proleptic Gregorian),
 * an hour to 23 or exactly 24:00:00, a minute to 59, and a zone within 15:59
 * either way. A leap second stays refused, as `Date.parse` refused it: the
 * column would take it, but only by rolling it into the next minute.
 */
function isTimestamp(value: string): boolean {
  const match = ISO_8601.exec(value);
  if (match === null) return false;
  const [, y, mo, d, h, mi, sec, fraction, zoneHours, zoneMinutes] = match.map((part) =>
    part === undefined ? undefined : Number(part),
  );
  const year = y ?? 0;
  const month = mo ?? 0;
  const day = d ?? 0;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return false;
  const [hour, minute, second] = [h ?? 0, mi ?? 0, sec ?? 0];
  const midnightAfter = hour === 24 && minute === 0 && second === 0 && (fraction ?? 0) === 0;
  if ((hour > 23 && !midnightAfter) || minute > 59 || second > 59) return false;
  return (zoneHours ?? 0) <= 15 && (zoneMinutes ?? 0) <= 59;
}

function fits(value: unknown, valueType: FieldDefinition['valueType']): boolean {
  switch (valueType) {
    case 'uuid':
      return isUuid(value);
    case 'text':
      // A NUL byte cannot be stored in a text column or a jsonb string, so a
      // value carrying one is refused here rather than raised on by the
      // server. It arrives from real clients: a fixed-width field padded with
      // zeros, a C string that kept its terminator. An unpaired surrogate is
      // the same case: half of a character a client split (final review
      // round 1, FR1-JSONB continuation).
      return typeof value === 'string' && storableText(value);
    case 'numeric':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'timestamptz':
      return typeof value === 'string' && isTimestamp(value);
    case 'json':
      return storableJson(value);
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
