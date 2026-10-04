// SPDX-License-Identifier: AGPL-3.0-only
// Not built yet: the signature tests/ci/db-census.test.ts is written against.

export interface Census {
  readonly items: number;
  readonly placed: number;
  readonly missing: readonly string[];
  readonly twice: readonly string[];
  readonly extra: readonly string[];
  readonly tests: number;
}

export function censusOf(
  _items: readonly string[],
  _shards: readonly (readonly string[])[],
  _counts: Readonly<Record<string, number>>,
): Census {
  return { items: 0, placed: 0, missing: [], twice: [], extra: [], tests: 0 };
}
