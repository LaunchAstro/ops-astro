// SPDX-License-Identifier: AGPL-3.0-only
//
// The definer census reads the catalogue in one fixed order, whatever the
// database's collation, so the intended functions pass on any locale.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { catalogueFunctions } from './restricted-calls-catalogue.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the definer census accepts its intended functions on Postgres 17 at any collation',
  async () => {
    const db = await createFreshDatabase({ part: 'definer_census_order' });
    try {
      const source = readFileSync(new URL('./restricted-calls.test.ts', import.meta.url), 'utf8');
      const declaration = source.match(
        /const DEFINERS: readonly string\[\] = \[([\s\S]*?)\];/u,
      )?.[1];
      expect(declaration).toBeDefined();
      const intended = [...(declaration ?? '').matchAll(/'([^']+)'/gu)].map((one) => one[1]);
      const actual = (await catalogueFunctions(db.admin))
        .filter((one) => one.definer)
        .map((one) => one.signature);
      // Control: there is no missing or extra definer. Only the comparison's order fails.
      expect(new Set(actual)).toEqual(new Set(intended));
      expect(
        actual,
        'The census compares PostgreSQL collation order to a fixed literal order',
      ).toEqual(intended);
    } finally {
      await db.drop();
    }
  },
  180_000,
);
