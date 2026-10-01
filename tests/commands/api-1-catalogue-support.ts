// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1: what the catalogue suites share, the real parity run and a hand edit
// of one row.

import type { CatalogueRow } from '../../packages/core-wire/src/index.ts';
// @ts-expect-error -- a plain script with no declaration file
import { run } from '../../scripts/command-parity.mjs';

export interface Run {
  readonly rows: CatalogueRow[];
  readonly failures: string[];
}
export const real = (): Run => run() as Run;

/** The catalogue with one row changed by hand. */
export function edit(
  rows: readonly CatalogueRow[],
  name: string,
  change: Partial<CatalogueRow>,
): CatalogueRow[] {
  return rows.map((row) =>
    (row.command as string) === name ? Object.assign({}, row, change) : row,
  );
}
