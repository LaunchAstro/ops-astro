// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CAPTURE_CHAIN_TIMEOUT } from '../support/capture-chain-timeout.ts';

/** The named capture's own timeout, as its test declares it. */
function captureBudget(): number {
  const source = readFileSync(
    new URL('../surfaces/mp-1-1-tokens.test.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf("it('MP-1-1 harness captures: every built page");
  const end = /\n {2}\}, ([\d_]+)\);/u.exec(source.slice(start));
  if (start === -1 || end === null) throw new Error('the named capture declares no timeout');
  return Number(end[1]?.replaceAll('_', ''));
}

it('a proof that runs the named page capture waits longer than the capture is allowed to take', () => {
  const budget = captureBudget();
  expect(budget).toBeGreaterThan(0);
  expect(CAPTURE_CHAIN_TIMEOUT).toBeGreaterThan(budget);
});
