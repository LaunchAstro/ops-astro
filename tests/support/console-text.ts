// SPDX-License-Identifier: AGPL-3.0-only
//
// The one way a test turns a console call or a stream write into text it can
// search (catalogue #720). A capture that writes `String(part)` sees `[object Object]` for a
// value logged inside an object, so a no-secret check over that text passes
// whatever the object held. This writes the call as the console prints it,
// with no depth, array or string limit, so every nested value is in the text.
// Node cuts an object a `%s` or `%o` reads to depth 0 or 4 whatever options it
// is given, so every inspected value is written out here first (an object `%s`
// writes by its own toString keeps that text); a Buffer is written as the text
// its bytes carry, as `String(part)` did, not as hex. Where a proxy's trap
// throws deeper than the console reads, the console's own writing stands, so
// the rest of the call is never lost.

import { formatWithOptions, inspect, types } from 'node:util';

const whole = {
  depth: Infinity,
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  breakLength: Infinity,
} as const;

/** What `%o` shows beyond `%O`, at the same unlimited depth. */
const hidden = { ...whole, showHidden: true, showProxy: true } as const;

/** How the console's `%o` writes, depth 4 whatever it is given. */
const consoleHidden = { showHidden: true, showProxy: true, depth: 4 } as const;

/** How `%s` writes an object it inspects, rather than one with its own toString. */
const shallow = { ...whole, depth: 0, colors: false, compact: 3 } as const;

/**
 * A Buffer. A proxy is never one, since its traps can claim Buffer's
 * prototype for anything, and a value whose prototype walk throws is not one;
 * the console looks through both instead.
 */
function isBuffer(part: unknown): part is Buffer {
  try {
    return !types.isProxy(part) && Buffer.isBuffer(part);
  } catch {
    return false;
  }
}

/** The deeper writing, or the console's own when a trap makes the deeper one throw. */
function deeperOr(deeper: () => string, nodeText: () => string): string {
  try {
    return deeper();
  } catch {
    return nodeText();
  }
}

const inspected = (value: unknown, deep: object, shown: object = {}): string =>
  deeperOr(
    () => inspect(value, deep),
    () => inspect(value, shown),
  );

/** An argument outside the format: text as is, a Buffer as its text, the rest inspected whole. */
function written(part: unknown): string {
  if (typeof part === 'string') return part;
  return isBuffer(part) ? part.toString('utf8') : inspected(part, whole);
}

/** One console call's arguments as the console would print them, nothing cut short. */
export function consoleLine(...parts: readonly unknown[]): string {
  const [first, ...rest] = parts;
  if (typeof first !== 'string') return parts.map((part) => written(part)).join(' ');
  const args = [...rest];
  let next = 0;
  const format = first.replaceAll(/%([sjdOoifc%])/gu, (spec, letter: string) => {
    if (letter === '%' || next >= rest.length) return spec;
    const index = next++;
    const value = rest[index];
    if (isBuffer(value)) {
      args[index] = value.toString('utf8');
      return '%s';
    }
    if (letter === 'o' || letter === 'O') {
      args[index] =
        letter === 'o' ? inspected(value, hidden, consoleHidden) : inspected(value, whole);
      return '%s';
    }
    if (letter === 's' && typeof value === 'object' && value !== null) {
      const shown = formatWithOptions(whole, '%s', value);
      args[index] = deeperOr(
        () => (shown === inspect(value, shallow) ? inspect(value, whole) : shown),
        () => shown,
      );
      return '%s';
    }
    return spec;
  });
  for (let index = next; index < rest.length; index++) args[index] = written(rest[index]);
  return formatWithOptions(whole, format, ...args);
}

/** One chunk a stream write carried, as the terminal shows it: bytes decoded as text. */
export const streamText = (chunk: unknown): string =>
  chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
