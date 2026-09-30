// SPDX-License-Identifier: AGPL-3.0-only
//
// Type-level: `pnpm typecheck` covers tests/, so an unused expectation below fails it. Discovery
// asks a person's standing from the session, stated; an omitted one is a type error, never a default.

import { expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/index.ts';

it('a person principal without a stated standing does not type-check', () => {
  const rows = buildCatalogue([]);
  // @ts-expect-error -- a person's standing is required, never inferred
  const unstated = () => reachableBy(rows, { kind: 'person', grants: [] });
  expect(typeof unstated).toBe('function');
});
