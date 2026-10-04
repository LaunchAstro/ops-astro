// SPDX-License-Identifier: AGPL-3.0-only
//
// The one way a test turns a console call into text it can search (catalogue
// #720). A capture that writes `String(part)` sees `[object Object]` for a
// value logged inside an object, so a no-secret check over that text passes
// whatever the object held. This writes the call as the console prints it,
// with no depth, array or string limit, so every nested value is in the text.

import { formatWithOptions } from 'node:util';

const whole = {
  depth: Infinity,
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  breakLength: Infinity,
} as const;

/** One console call's arguments as the console would print them, nothing cut short. */
export const consoleLine = (...parts: readonly unknown[]): string =>
  formatWithOptions(whole, ...parts);
