// SPDX-License-Identifier: AGPL-3.0-only
//
// The mandate commands' closed inputs (MP-14-10a), moved whole from
// `mandates.ts` to keep that file under the per-file line cap. Each answers
// the value it accepts, or null, and the command names the field it refuses.

import type { MandateFiling } from '../../../core-records/src/index.ts';
import { labelText } from './values.ts';

type Ceiling = NonNullable<MandateFiling['ceiling']>;

export const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

/** Exactly `{ amountMinor, currency }`: a safe whole number and three capital letters. */
export function ceilingOf(value: unknown): Ceiling | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).toSorted();
  if (keys.length !== 2 || keys[0] !== 'amountMinor' || keys[1] !== 'currency') return null;
  const { amountMinor, currency } = value as Record<string, unknown>;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    return null;
  }
  const upper = typeof currency === 'string' && currency.length === 3;
  if (!upper || [...currency].some((one) => one < 'A' || one > 'Z')) return null;
  return { amountMinor, currency };
}

/**
 * One form only, the one `Date.prototype.toISOString` writes for a year from
 * 0001 to 9999: a time that does not read back as itself is refused, so no
 * locale or partial date is guessed. `toISOString` also writes year 0000 and
 * the signed six-digit years, which the column refuses, so those are refused
 * here by name rather than raised on by the insert. Whether it is far enough
 * ahead is the insert's, on the database's clock.
 */
export function expiryOf(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length !== 24) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== value) return null;
  return at.getUTCFullYear() >= 1 ? at : null;
}

/**
 * The sentence, 1 to 500 characters of `labelText` (values.ts): no control,
 * line break, escape, bidi control or character that draws as nothing, and
 * something that draws. It is the only human text on a money pre-approval, so
 * what another administrator is shown is what was filed. That grammar also
 * holds out a NUL and a lone surrogate, which Postgres text and jsonb refuse.
 */
export function labelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label.length <= 500 && labelText(label) ? label : null;
}

/**
 * A row's name as a promote's label shows it: the name when it is a label's
 * text, otherwise `fallback`, an identifier. A class label (written by the
 * agent loops) and a client name (`client.create` trims and bounds it, nothing
 * more) are not held to the label grammar where they are written.
 */
export const shownAs = (name: string, fallback: string): string =>
  labelText(name) ? name : fallback;

/** Distinct entries of the client's own scope list, compared whole. */
export function classesOf(value: unknown, choices: readonly string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  if (!value.every((one): one is string => typeof one === 'string' && choices.includes(one))) {
    return null;
  }
  return new Set(value).size === value.length ? value : null;
}
