// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's small formatters, shared by its parts.

export const shortDigest = (digest: string): string => digest.slice(0, 12);

export const money = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toFixed(2)}`;

/** A stored code such as `request_changes`, read as words. */
export const words = (code: string): string => code.replaceAll('_', ' ');

/** Dollars as whole minor units, or null for anything that is not a figure of 0 or more. */
export function minorOf(amount: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(amount.trim())) return null;
  return Math.round(Number(amount.trim()) * 100);
}
