// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's small formatters, shared by its parts.

export const shortDigest = (digest: string): string => digest.slice(0, 12);

export const money = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toFixed(2)}`;

/** A stored code such as `request_changes`, read as words. */
export const words = (code: string): string => code.replaceAll('_', ' ');
