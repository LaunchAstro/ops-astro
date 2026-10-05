// SPDX-License-Identifier: AGPL-3.0-only
//
// The mandate commands' closed inputs (MP-14-10a), moved whole from
// `mandates.ts` to keep that file under the per-file line cap. Each answers
// the value it accepts, or null, and the command names the field it refuses.

import type { MandateFiling } from '../../../core-records/src/index.ts';
import { storableText } from './values.ts';

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
 * One form only, the one `Date.prototype.toISOString` writes: a time that does
 * not read back as itself is refused, so no locale or partial date is guessed.
 * Whether it is far enough ahead is the insert's, on the database's clock.
 */
export function expiryOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) || at.toISOString() !== value ? null : at;
}

export function labelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  // Postgres text and jsonb (the audit row) refuse a NUL and a lone surrogate.
  if (label.length === 0 || label.length > 500 || !storableText(label)) return null;
  return label;
}

/** Distinct entries of the client's own scope list, compared whole. */
export function classesOf(value: unknown, choices: readonly string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  if (!value.every((one): one is string => typeof one === 'string' && choices.includes(one))) {
    return null;
  }
  return new Set(value).size === value.length ? value : null;
}
