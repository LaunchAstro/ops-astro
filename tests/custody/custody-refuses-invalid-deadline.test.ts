// SPDX-License-Identifier: AGPL-3.0-only
//
// A dispatch whose deadline no timer can keep (negative, fractional, not a
// number, or past the timer's ceiling) is refused for that call alone, through
// custody's own process: the next valid call is still answered.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { openCustodyWorld, type CustodyWorld } from './custody-world.ts';

let world: CustodyWorld;

// A custody of its own per case, so one case's crash cannot fail the next.
beforeEach(async () => {
  world = await openCustodyWorld();
});

afterEach(async () => {
  await world?.close();
});

it.each([
  ['negative', -1],
  ['not a number', Number.NaN],
  ['fractional', 1.5],
  ['past the timer ceiling', 2 ** 31],
  ['past an unsigned 32-bit count', 2 ** 32],
])('a %s deadline is refused and custody still answers the next call', async (_case, timeoutMs) => {
  const refused = await world.custody.dispatch('replay_key', world.request({ timeoutMs }));
  const next = await world.custody.dispatch('replay_key', world.request());
  expect({
    refused,
    next: next.kind === 'answered' && next.outbound.ok,
  }).toEqual({
    refused: { kind: 'refused', started: false, code: 'CUSTODY_REQUEST_MALFORMED' },
    next: true,
  });
});
