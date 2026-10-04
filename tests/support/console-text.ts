// SPDX-License-Identifier: AGPL-3.0-only
//
// The one way a test turns a console call or a stream write into text it can
// search (catalogue #720). A capture that writes `String(part)` sees `[object Object]` for a
// value logged inside an object, so a no-secret check over that text passes
// whatever the object held. This writes the call as the console prints it,
// with no depth, array or string limit, so every nested value is in the text.
// Node cuts an object a `%s` or `%o` reads to depth 0 or 4 whatever options it
// is given, so those are written out here first; a Buffer is written as the
// text its bytes carry, as `String(part)` did, not as hex.

import { formatWithOptions, inspect } from 'node:util';

const whole = {
  depth: Infinity,
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  breakLength: Infinity,
} as const;

/** What `%o` shows beyond `%O`, at the same unlimited depth. */
const hidden = { ...whole, showHidden: true, showProxy: true } as const;

const bytesAsText = (part: unknown): unknown =>
  Buffer.isBuffer(part) ? part.toString('utf8') : part;

/** One console call's arguments as the console would print them, nothing cut short. */
export function consoleLine(...parts: readonly unknown[]): string {
  const [first, ...rest] = parts;
  if (typeof first !== 'string') {
    return parts.map((part) => formatWithOptions(whole, bytesAsText(part))).join(' ');
  }
  const args = rest.map(bytesAsText);
  let next = 0;
  const format = first.replace(/%([sjdOoifc%])/gu, (spec, letter: string) => {
    if (letter === '%' || next >= rest.length) return spec;
    const index = next++;
    const value = rest[index];
    if (Buffer.isBuffer(value)) return '%s';
    if (letter === 'o') {
      args[index] = inspect(value, hidden);
      return '%s';
    }
    if (letter === 's' && typeof value === 'object' && value !== null) {
      args[index] = inspect(value, whole);
      return '%s';
    }
    return spec;
  });
  return formatWithOptions(whole, format, ...args);
}

/** One chunk a stream write carried, as the terminal shows it: bytes decoded as text. */
export const streamText = (chunk: unknown): string =>
  chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
