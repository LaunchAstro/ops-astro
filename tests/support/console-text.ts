// SPDX-License-Identifier: AGPL-3.0-only
//
// The one way a test turns a console call or a stream write into text it can
// search (catalogue #720). A capture that writes `String(part)` sees `[object Object]` for a
// value logged inside an object, so a no-secret check over that text passes
// whatever the object held. This keeps the line the console prints, with no
// depth, array or string limit, then adds what each object argument holds that
// the line can still hide: Node reads an object under `%s` at depth 0 and under
// `%o` at depth 4 whatever options it is given, prints a Buffer as hex, and
// leaves non-enumerable keys out. Nothing the console prints is replaced, so
// the text is never less than the console's line.

import { format, formatWithOptions, inspect, types } from 'node:util';

const whole = {
  depth: Infinity,
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  breakLength: Infinity,
} as const;

/** Everything an object holds, its hidden keys and a proxy's target too. */
const hidden = { ...whole, showHidden: true, showProxy: true } as const;

/** A thing written, or nothing when a proxy's trap or a getter throws on the way. */
function orNothing(write: () => string): string {
  try {
    return write();
  } catch {
    return '';
  }
}

/** What an object argument holds beyond the console's line: a Buffer's text, or all of it. */
const held = (part: object): string =>
  types.isProxy(part)
    ? orNothing(() => inspect(part, hidden))
    : orNothing(() =>
        Buffer.isBuffer(part)
          ? Buffer.prototype.toString.call(part, 'utf8')
          : inspect(part, hidden),
      );

/** One console call's arguments as the console would print them, nothing cut short. */
export function consoleLine(...parts: readonly unknown[]): string {
  const line = orNothing(() => formatWithOptions(whole, ...parts)) || format(...parts);
  const more = parts
    .filter(
      (part): part is object =>
        (typeof part === 'object' && part !== null) || typeof part === 'function',
    )
    .map((part) => held(part))
    .filter(Boolean);
  return [line, ...more].join(' ');
}

/** One chunk a stream write carried, as the terminal shows it: bytes decoded as text. */
export const streamText = (chunk: unknown): string =>
  chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
