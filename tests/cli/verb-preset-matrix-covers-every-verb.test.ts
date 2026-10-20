// SPDX-License-Identifier: AGPL-3.0-only
//
// The preset matrix runs every verb from `SMALLEST_LINE`, so that list must
// name exactly the verbs `VERB_TABLE` has: a new verb fails here until it has
// a line, and a line names its own verb.

import { expect, it } from 'vitest';
import { VERB_TABLE } from '../../apps/cli/verbs.ts';
import { SMALLEST_LINE } from './verb-lines.ts';

it('the matrix has one line for each verb in the table, map list included', () => {
  const table = VERB_TABLE.map((row) => row.verb).toSorted();
  expect(Object.keys(SMALLEST_LINE).toSorted()).toStrictEqual(table);
  expect(table).toContain('map list');
});

it('each line starts with the words of the verb it stands for', () => {
  for (const [verb, line] of Object.entries(SMALLEST_LINE)) {
    expect(line.slice(0, 2).join(' '), verb).toBe(verb);
  }
});
