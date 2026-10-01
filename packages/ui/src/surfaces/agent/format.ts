// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's small formatters, shared by its parts.

import { minorDigits } from '../../../../core-wire/src/index.ts';

// A currency's minor digits come from the ISO 4217 table the server reads too
// (core-runtime `four-eyes.ts`), so a figure means the same in both.
export { minorDigits };

export const shortDigest = (digest: string): string => digest.slice(0, 12);

/** Minor units as the currency's major figure, with its own digits: 2500 AUD is 25.00. */
export const major = (minor: number, currency: string): string => {
  const digits = minorDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
};

export const money = (minor: number, currency: string): string =>
  `${currency} ${major(minor, currency)}`;

/** A stored code such as `request_changes`, read as words. */
export const words = (code: string): string => code.replaceAll('_', ' ');

/** A figure in the currency as whole minor units, or null for anything that is not one of 0 or more. */
export function minorOf(amount: string, currency: string): number | null {
  const digits = minorDigits(currency);
  const fraction = digits === 0 ? '' : `(?:\\.\\d{1,${String(digits)}})?`;
  if (!new RegExp(`^\\d+${fraction}$`, 'u').test(amount.trim())) return null;
  return Math.round(Number(amount.trim()) * 10 ** digits);
}
