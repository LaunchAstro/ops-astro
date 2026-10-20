// SPDX-License-Identifier: AGPL-3.0-only
//
// A read's identifier operands in their stored spelling. `isUuid` accepts
// either letter case and Postgres reads both as one uuid, but stored ids are
// lowercase and many reads compare an id as text: an effect identity built
// from it, a grant's record list, a JSON field. Lowercased once here, where
// the read is parsed, no read further in sees another spelling. Only the
// fields the read names as identifiers (its row's `identifiers`) change; any
// other operand, a preset name that looks like a uuid among them, keeps its case.

import { isUuid } from '../../../core-records/src/index.ts';

/** `operands` with each named identifier field that holds a uuid lowercased. */
export function canonicalIds<T extends object>(operands: T, identifiers: readonly string[]): T {
  const named = Object.entries(operands).map(([key, value]: [string, unknown]) => [
    key,
    identifiers.includes(key) && isUuid(value) ? value.toLowerCase() : value,
  ]);
  return Object.fromEntries(named) as T;
}
