// SPDX-License-Identifier: AGPL-3.0-only
//
// A candidate or manifest output named directly beneath / resolves to that
// very name: the parent's separator is not counted twice, so no character of
// the file name is lost. Nothing is written; the name is unique and absent.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';

const SNAPSHOT = '../../scripts/candidate-snapshot.mjs';
const { externalOutput } = (await import(
  /* @vite-ignore */
  SNAPSHOT
)) as { externalOutput: (path: string, roots: string[]) => string };

it('resolves an output whose parent is / to the name asked for', () => {
  const wanted = `/candidate-output-${randomBytes(8).toString('hex')}.json`;
  expect(externalOutput(wanted, []), 'the first character of the name is dropped').toBe(wanted);
});
