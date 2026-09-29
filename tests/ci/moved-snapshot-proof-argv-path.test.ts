// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('moved snapshot proof argv names the current module path', () => {
  const source = readFileSync(
    'tests/fixture/snapshot/snapshot-container-identity-proof.test.ts',
    'utf8',
  );
  expect(source).toContain("process.argv = ['node', 'tests/fixture/snapshot/snapshot.ts'");
});
