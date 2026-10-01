// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/index.ts';

it('a person with a live task grant can discover own inbox reads', () => {
  const available = reachableBy(buildCatalogue([]), {
    kind: 'person',
    grants: [{ key: 'task:read', scope: { kind: 'business', id: null } }],
    member: true,
  }).map((row) => row.command);
  expect(available).toContain('inbox.read');
  expect(available).toContain('inbox.count');
});
