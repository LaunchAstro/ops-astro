// SPDX-License-Identifier: AGPL-3.0-only
//
// The one shape check for an identifier. Every id column is a uuid, and a
// string that is not one would reach a bound parameter and be raised on by the
// server. Every module imports the regex from this leaf, which imports
// nothing, so there is one copy of it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether `value` is a string in the uuid shape, any case. Says nothing about whether it names a row. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
