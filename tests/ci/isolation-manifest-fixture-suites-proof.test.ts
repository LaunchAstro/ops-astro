// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('the isolation manifest runs both fixture suites after the snapshot move', () => {
  const manifest = JSON.parse(readFileSync('tests/db/isolation-suites.json', 'utf8')) as {
    invariant: string[];
  };
  const required = [
    'tests/fixture/fixture-shape.test.ts',
    'tests/fixture/snapshot/snapshot-clone-and-privileges.test.ts',
  ];
  expect(required.filter((suite) => manifest.invariant.includes(suite))).toStrictEqual(required);
});
