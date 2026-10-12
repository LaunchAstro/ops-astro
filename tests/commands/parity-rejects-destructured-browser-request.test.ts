// SPDX-License-Identifier: AGPL-3.0-only
//
// A request global taken out of `window` under another name is still a request
// the app sends itself: parity names the file whatever the local is called.

import { expect, it } from 'vitest';

const PARITY = '../../scripts/command-parity.mjs';
const { run } = (await import(
  /* @vite-ignore */
  PARITY
)) as { run: (files: Map<string, string>) => { failures: string[] } };

it.each([
  ['fetch renamed', "const { fetch: send } = window;\nvoid send('/x', { method: 'POST' });"],
  ['fetch renamed off globalThis', "const { fetch: f } = globalThis;\nvoid f('/x');"],
  ['a nested beacon', "const { navigator: { sendBeacon: b } } = window;\nb('/x');"],
])('names a file that sends through a destructured request global: %s', (_what, source) => {
  expect(run(new Map([['planted.ts', source]])).failures).toEqual([
    'planted.ts sends a request itself, with no command or CLI verb',
  ]);
});
