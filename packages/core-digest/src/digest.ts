// SPDX-License-Identifier: AGPL-3.0-only
//
// The canonical form of a command payload, and its digest.
//
// The repeat-request rule turns on one comparison: the same `operation_id`
// with the same payload replays the original result, and the same identity
// with a *different* payload is refused `OPERATION_ID_REUSED` (minimum
// contract, 4.2). So "the same payload" has to be a decidable question, and
// `JSON.stringify` does not decide it: it preserves insertion order, so two
// clients sending the same fields in a different order would disagree.
//
// What is stored is the digest, never the payload. An audit event carries a
// payload digest rather than the payload (minimum contract 4.2, audit row),
// and the register carries the same digest so the two can be tied together
// without either of them holding a value.
//
// This refuses rather than coerces. A `Date`, a `bigint`, a function and a
// non-finite number all have a JSON spelling that loses information — a Date
// becomes a string that no longer parses back as a Date, `NaN` becomes `null`,
// a function disappears — and every one of those is a payload whose digest
// would say two different requests were the same. A refusal here is a bug
// found at the boundary; a coercion is a repeat-request register that quietly
// stops working.

import { createHash } from 'node:crypto';

function unsupported(value: unknown, path: string): Error {
  return new Error(
    `canonicalPayload: ${path} is a ${typeof value === 'object' ? 'value' : typeof value} ` +
      `with no canonical form. A command payload holds strings, finite numbers, ` +
      `booleans, null, arrays and plain objects.`,
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw unsupported(value, path);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw unsupported(value, path);
  }

  const object = value as object;
  if (Array.isArray(object)) {
    // Order is kept. Two clients sending the same members in a different order
    // have sent different requests, and a list of subtasks proves it.
    return `[${object.map((member, index) => write(member, `${path}[${index}]`)).join(',')}]`;
  }
  if (!isPlainObject(object)) throw unsupported(object, path);

  // An undefined member is dropped rather than written, because an optional
  // field left off and an optional field set to undefined are the same
  // request. An explicit null is *not* dropped: "clear the due date" and "do
  // not change the due date" are different requests (specification, 14.2).
  const entries = Object.entries(object as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const written = entries.map(
    ([key, member]) => `${JSON.stringify(key)}:${write(member, `${path}.${key}`)}`,
  );
  return `{${written.join(',')}}`;
}

/** One string for one payload, whatever order its keys arrived in. */
export function canonicalPayload(value: unknown): string {
  return write(value, 'payload');
}

/** The digest the register compares and the audit event carries. */
export function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalPayload(value), 'utf8').digest('hex');
}
