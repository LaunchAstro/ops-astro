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

import { isLive, isUuid } from '../../../core-records/src/index.ts';
import type { FieldDefinition } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { FieldValues } from './requests.ts';

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
 * The one definition of the rule. The
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
 * `Date.parse` is more forgiving than the column: it reads '1' as the year
 * 2001, rolls 30 February over into March and takes an offset of +20:00, all
 * of which Postgres refuses, so `due: '2026-02-30'` would reach the column
 * and be answered as a fault. So the fields
 * are read from the shape and held to the column's ranges, measured against
 * Postgres 18: a year from 1, a real day of that month (proleptic Gregorian),
 * an hour to 23 or exactly 24:00:00, a minute to 59, and a zone within 15:59
 * either way. A leap second stays refused, as `Date.parse` refuses it: the
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
      // the same case: half of a character a client split.
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

/** A run of code points, first and last inclusive. */
type Span = readonly [number, number];

// READABLE: the code points a name or a sentence a person reads may hold,
// listed: printable ASCII and every later code point but the C1 controls, the
// line and paragraph separators (U+2028-2029), the bidi marks and overrides
// (U+061C, U+200E-200F, U+202A-202E, U+2066-2069) and the surrogates. So no
// control character, line break or escape, and no text that reorders what an
// admin reads; the joiners emoji need stay. A lone surrogate is one code point
// outside every span, so it is refused too.
const READABLE: readonly Span[] = [
  [0x20, 0x7e],
  [0xa0, 0x6_1b],
  [0x6_1d, 0x20_0d],
  [0x20_10, 0x20_27],
  [0x20_2f, 0x20_65],
  [0x20_6a, 0xd7_ff],
  [0xe0_00, 0x10_ff_ff],
];

// What a label also leaves out of READABLE: the default-ignorable code points
// (Unicode's DerivedCoreProperties), which draw as nothing, the interlinear
// annotation and hieroglyph format controls, every variation selector but
// U+FE0E-FE0F, the tag characters, and so the non-joiner: all can carry text no
// one sees. Also every space but U+0020, and the characters that draw blank
// (U+2800, U+13441-13442, U+16FE4, U+1D159), which pass for a space or for
// nothing. The joiner (U+200D) and U+FE0E-FE0F stay, only where `labelText`
// places them.
const UNSEEN: readonly Span[] = [
  [0xa0, 0xa0],
  [0xad, 0xad],
  [0x3_4f, 0x3_4f],
  [0x11_5f, 0x11_60],
  [0x16_80, 0x16_80],
  [0x17_b4, 0x17_b5],
  [0x18_0b, 0x18_0f],
  [0x20_00, 0x20_0c],
  [0x20_2f, 0x20_2f],
  [0x20_5f, 0x20_6f],
  [0x28_00, 0x28_00],
  [0x30_00, 0x30_00],
  [0x31_64, 0x31_64],
  [0xfe_00, 0xfe_0d],
  [0xfe_ff, 0xfe_ff],
  [0xff_a0, 0xff_a0],
  [0xff_f0, 0xff_fb],
  [0x1_34_30, 0x1_34_3f],
  [0x1_34_41, 0x1_34_42],
  [0x1_6f_e4, 0x1_6f_e4],
  [0x1_bc_a0, 0x1_bc_a3],
  [0x1_d1_59, 0x1_d1_59],
  [0x1_d1_73, 0x1_d1_7a],
  [0xe_00_00, 0xe_0f_ff],
];

/** The spans of `spans` with every code point of `holes` taken out. */
function without(spans: readonly Span[], holes: readonly Span[]): readonly Span[] {
  return holes.reduce<readonly Span[]>(
    (kept, [from, to]) =>
      kept.flatMap(([first, last]): Span[] => {
        if (to < first || from > last) return [[first, last]];
        const parts: Span[] = [];
        if (first < from) parts.push([first, from - 1]);
        if (to < last) parts.push([to + 1, last]);
        return parts;
      }),
    spans,
  );
}

const LABEL: readonly Span[] = without(READABLE, UNSEEN);

const within = (spans: readonly Span[], value: string): boolean =>
  [...value].every((one) => {
    const code = one.codePointAt(0) ?? -1;
    return spans.some(([first, last]) => code >= first && code <= last);
  });

/**
 * Text a person reads as sent: every code point is on the READABLE list, so
 * it holds no control, line break, escape or bidi control. The one definition;
 * an automation's name and inputs and a mandate's label read it.
 */
export function readableText(value: string): boolean {
  return within(READABLE, value);
}

// A letter, a number, punctuation or a symbol: something that draws.
const DRAWS = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
// Unassigned, private-use and noncharacter code points draw as the same box.
const NO_GLYPH = /^[\p{Cn}\p{Co}]$/u;
const MARK = /^\p{M}$/u;
const MOST_MARKS = 4;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
// The joiner only inside an emoji sequence: after a pictograph, a skin tone or
// U+FE0F, and before a pictograph.
const BEFORE_JOINER = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]$/u;

/** U+FE0E or U+FE0F straight after a pictograph, or a keycap's: a digit, # or * then U+20E3. */
const presents = (before: string, after: string): boolean =>
  PICTOGRAPH.test(before) || (/^[\d#*]$/u.test(before) && after === '\u{20E3}');

/**
 * A label a person reads beside an approval, read one code point at a time:
 * readable text with nothing that draws as nothing or as a blank (UNSEEN) and
 * no code point without a glyph of its own; U+FE0E-FE0F only on a pictograph or
 * a keycap, the joiner only inside an emoji sequence, at most four combining
 * marks on one character and none before the first, and at least one character
 * that draws. So what another person is shown is the whole statement filed.
 */
export function labelText(value: string): boolean {
  const points = [...value];
  if (!within(LABEL, value) || !points.some((one) => DRAWS.test(one))) return false;
  // Combining marks on the current character; -1 before the first character.
  let marks = -1;
  for (const [at, one] of points.entries()) {
    const [before, after] = [points[at - 1] ?? '', points[at + 1] ?? ''];
    if (NO_GLYPH.test(one)) return false;
    if (one === '\u{200D}') {
      if (!BEFORE_JOINER.test(before) || !PICTOGRAPH.test(after)) return false;
      marks = -1;
    } else if (MARK.test(one)) {
      if (marks < 0 || marks >= MOST_MARKS) return false;
      if ((one === '\u{FE0E}' || one === '\u{FE0F}') && (marks > 0 || !presents(before, after))) {
        return false;
      }
      marks += 1;
    } else marks = 0;
  }
  return true;
}
