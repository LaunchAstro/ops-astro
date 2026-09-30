// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/index.ts';

it('a person without a live grant cannot discover refused inbox reads', () => {
  const discovered = reachableBy(buildCatalogue([]), { kind: 'person', grants: [] }).map(
    (row) => row.command,
  );
  expect(discovered).not.toContain('inbox.read');
  expect(discovered).not.toContain('inbox.count');
});
