// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a: the fixture generator. Red-first stub; the generator lands next.

import type { EmptyDatabase } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { FixtureShape } from './shape.ts';

export interface FixtureReport {
  readonly board: string;
  readonly recordGrantTask: string;
  readonly slots: { readonly assigned: number; readonly total: number };
  readonly people: { readonly alpha: readonly string[]; readonly bravo: readonly string[] };
  readonly seedMs: number;
}

export async function seedFixture(
  _db: EmptyDatabase,
  _shape: FixtureShape,
): Promise<FixtureReport> {
  throw new Error('T4a: the fixture generator is not built yet');
}
