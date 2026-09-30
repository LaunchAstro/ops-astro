// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('T4a moved isolation proof reads only the approved fixture suite', () => {
  const read = readdirSync('tests/fixture')
    .filter((name) => name.endsWith('.test.ts') && !name.startsWith('sol-'))
    .toSorted();

  expect(read).toStrictEqual(['fixture-shape.test.ts']);
});
