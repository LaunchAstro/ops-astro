// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 guarded call: a declared response field is read by its dotted path, and
// a list only by a plain index from 0 to 999999. A list's own properties, a
// signed, padded or longer index, and an object's inherited keys read nothing.

import { expect, it } from 'vitest';
import { readField } from '../../packages/core-connectors/src/call.ts';

const list: string[] = ['zero', 'one'];
list[1_000_000] = 'far';
const body = { x: list };

it('reads a list at a plain index', () => {
  expect(readField(body, 'x.0')).toBe('zero');
});

it.each(['x.length', 'x.-1', 'x.01', 'x.1000000', 'x.constructor', '__proto__', 'constructor'])(
  '%s reads nothing',
  (dotted) => {
    expect(readField(body, dotted)).toBeUndefined();
  },
);
