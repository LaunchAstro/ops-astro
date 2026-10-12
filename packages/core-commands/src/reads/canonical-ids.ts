// SPDX-License-Identifier: AGPL-3.0-only
//
// A read's operands with every identifier in its stored spelling. `isUuid`
// accepts either letter case and Postgres reads both as one uuid, but stored
// ids are lowercase and many reads compare an id as text: an effect identity
// built from it, a grant's record list, a JSON field. Lowercased once here,
// where the read is parsed, no read further in sees another spelling.

import { isUuid } from '../../../core-records/src/index.ts';

/** `value` with each uuid-shaped string in it lowercased, at any depth; nothing else changes. */
export function canonicalIds<T>(value: T): T {
  if (isUuid(value)) return value.toLowerCase() as T;
  if (Array.isArray(value)) return value.map((each: unknown) => canonicalIds(each)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, canonicalIds(each)]),
    ) as T;
  }
  return value;
}
