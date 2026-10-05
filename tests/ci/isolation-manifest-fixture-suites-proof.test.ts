// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { readIsolationSuites } from '../../scripts/named-suites.ts';

it('the isolation manifest runs both fixture suites after the snapshot move', () => {
  const manifest = readIsolationSuites(process.cwd());
  const required = [
    'tests/fixture/fixture-shape.test.ts',
    'tests/fixture/snapshot/snapshot-clone-and-privileges.test.ts',
  ];
  expect(required.filter((suite) => manifest.invariant.includes(suite))).toStrictEqual(required);
});
